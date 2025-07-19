import type { Message } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import {
  countMessagesTokens,
  countSystemTokens,
  calculateAvailableTokens,
  getModelContextWindow,
  countMessageTokens,
  countTokens,
} from './token-counter';
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  CONTEXT_BUFFER_TOKENS,
  MIN_COMPLETION_TOKENS,
  SYSTEM_PROMPT_BUFFER,
} from './constants';

const logger = createScopedLogger('context-manager');

export interface ContextManagementOptions {
  model: string;
  maxContextTokens?: number;
  completionTokens?: number;
  bufferTokens?: number;
  preserveSystemMessage?: boolean;
  preserveLastUserMessage?: boolean;
  summarizationThreshold?: number;
}

export interface ContextManagementResult {
  messages: Message[];
  systemPrompt: string;
  totalTokens: number;
  truncated: boolean;
  removedMessages: number;
  strategy: 'none' | 'truncate-old' | 'sliding-window' | 'summarize' | 'system-prompt-truncation';
  systemPromptTruncated: boolean;
}

/**
 * Manages context window to prevent token limit overflow
 */
export class ContextManager {
  private options: Required<ContextManagementOptions>;

  constructor(options: ContextManagementOptions) {
    const defaultMaxTokens = getModelContextWindow(options.model);
    this.options = {
      completionTokens: MIN_COMPLETION_TOKENS,
      bufferTokens: CONTEXT_BUFFER_TOKENS,
      preserveSystemMessage: true,
      preserveLastUserMessage: true,
      summarizationThreshold: 10,
      maxContextTokens: defaultMaxTokens,
      ...options, // This will override defaults with provided options
    };
  }

  /**
   * Optimize messages to fit within context window
   */
  async optimizeMessages(
    messages: Message[],
    systemPrompt: string,
    contextFiles?: string,
  ): Promise<ContextManagementResult> {
    // First, check if system prompt needs truncation (40% of context window max)
    const maxSystemPromptTokens = Math.floor(this.options.maxContextTokens * 0.4);
    let finalSystemPrompt = systemPrompt;
    let systemPromptTruncated = false;

    const initialSystemTokens = countSystemTokens(systemPrompt, contextFiles, this.options.model);

    if (initialSystemTokens > maxSystemPromptTokens) {
      logger.warn(`System prompt too large: ${initialSystemTokens} tokens > ${maxSystemPromptTokens} limit (40% of context window)`);
      finalSystemPrompt = this.truncateSystemPrompt(systemPrompt, maxSystemPromptTokens);
      systemPromptTruncated = true;
      logger.info(`System prompt truncated to ${maxSystemPromptTokens} tokens`);
    }

    const systemTokens = countSystemTokens(finalSystemPrompt, contextFiles, this.options.model);
    const availableTokens = calculateAvailableTokens(
      this.options.model,
      systemTokens,
      this.options.completionTokens,
      this.options.bufferTokens,
    );

    logger.info(`Context optimization: ${availableTokens} tokens available for messages`);

    // First, try without any optimization
    const currentMessages = [...messages];
    const currentTokens = countMessagesTokens(currentMessages, this.options.model);

    if (currentTokens <= availableTokens) {
      return {
        messages: currentMessages,
        systemPrompt: finalSystemPrompt,
        totalTokens: currentTokens,
        truncated: systemPromptTruncated,
        removedMessages: 0,
        strategy: systemPromptTruncated ? 'system-prompt-truncation' : 'none',
        systemPromptTruncated,
      };
    }

    logger.warn(`Messages exceed available tokens: ${currentTokens} > ${availableTokens}`);

    // Strategy 1: Remove old messages (sliding window)
    const slidingWindowResult = this.applySlidingWindow(currentMessages, availableTokens, finalSystemPrompt, systemPromptTruncated);

    if (slidingWindowResult.totalTokens <= availableTokens) {
      return slidingWindowResult;
    }

    // Strategy 2: Aggressive truncation
    const truncationResult = this.applyAggressiveTruncation(currentMessages, availableTokens, finalSystemPrompt, systemPromptTruncated);

    if (truncationResult.totalTokens <= availableTokens) {
      return truncationResult;
    }

    // Strategy 3: Emergency fallback - keep only the last user message
    const emergencyResult = this.applyEmergencyTruncation(currentMessages, availableTokens, finalSystemPrompt, systemPromptTruncated);

    // Final safety check - if still too large, apply extreme truncation
    if (emergencyResult.totalTokens > availableTokens) {
      logger.warn(
        `Even emergency truncation failed. Applying extreme truncation. Current: ${emergencyResult.totalTokens}, Available: ${availableTokens}`,
      );
      return this.applyExtremeTruncation(currentMessages, availableTokens, finalSystemPrompt, systemPromptTruncated);
    }

    return emergencyResult;
  }

  /**
   * Apply sliding window approach - remove oldest messages first
   */
  private applySlidingWindow(messages: Message[], availableTokens: number, finalSystemPrompt: string, systemPromptTruncated: boolean): ContextManagementResult {
    const workingMessages = [...messages];
    let removedCount = 0;

    // Always preserve the last user message if specified
    const lastUserMessageIndex = this.findLastUserMessageIndex(workingMessages);
    const preserveIndices = new Set<number>();

    if (this.options.preserveLastUserMessage && lastUserMessageIndex !== -1) {
      preserveIndices.add(lastUserMessageIndex);

      // Also preserve the assistant response if it exists
      if (lastUserMessageIndex + 1 < workingMessages.length) {
        preserveIndices.add(lastUserMessageIndex + 1);
      }
    }

    // Remove messages from the beginning, but preserve important ones
    while (workingMessages.length > 0) {
      const currentTokens = countMessagesTokens(workingMessages, this.options.model);

      if (currentTokens <= availableTokens) {
        break;
      }

      // Find the first message we can remove
      let removedMessage = false;

      for (let i = 0; i < workingMessages.length; i++) {
        if (!preserveIndices.has(i)) {
          workingMessages.splice(i, 1);
          removedCount++;
          removedMessage = true;

          // Update preserve indices after removal
          const newPreserveIndices = new Set<number>();

          for (const index of preserveIndices) {
            if (index > i) {
              newPreserveIndices.add(index - 1);
            } else if (index < i) {
              newPreserveIndices.add(index);
            }
          }
          preserveIndices.clear();
          newPreserveIndices.forEach((idx) => preserveIndices.add(idx));
          break;
        }
      }

      if (!removedMessage) {
        // Can't remove any more messages without breaking preservation rules
        break;
      }
    }

    return {
      messages: workingMessages,
      systemPrompt: finalSystemPrompt,
      totalTokens: countMessagesTokens(workingMessages, this.options.model),
      truncated: removedCount > 0 || systemPromptTruncated,
      removedMessages: removedCount,
      strategy: 'sliding-window',
      systemPromptTruncated,
    };
  }

  /**
   * Apply aggressive truncation - remove messages more aggressively
   */
  private applyAggressiveTruncation(messages: Message[], availableTokens: number, finalSystemPrompt: string, systemPromptTruncated: boolean): ContextManagementResult {
    const workingMessages = [...messages];
    let removedCount = 0;

    // Keep only the last few messages
    const lastUserMessageIndex = this.findLastUserMessageIndex(workingMessages);

    if (lastUserMessageIndex !== -1) {
      // Keep the last user message and any subsequent assistant response
      const keepFromIndex = Math.max(0, lastUserMessageIndex - 2); // Keep 2 messages before last user message
      const removedFromStart = keepFromIndex;
      workingMessages.splice(0, removedFromStart);
      removedCount += removedFromStart;
    } else {
      // No user message found, keep only the last 3 messages
      const keepCount = Math.min(3, workingMessages.length);
      const removeCount = workingMessages.length - keepCount;
      workingMessages.splice(0, removeCount);
      removedCount += removeCount;
    }

    return {
      messages: workingMessages,
      systemPrompt: finalSystemPrompt,
      totalTokens: countMessagesTokens(workingMessages, this.options.model),
      truncated: removedCount > 0 || systemPromptTruncated,
      removedMessages: removedCount,
      strategy: 'truncate-old',
      systemPromptTruncated,
    };
  }

  /**
   * Emergency truncation - keep only the absolute minimum
   */
  private applyEmergencyTruncation(messages: Message[], availableTokens: number, finalSystemPrompt: string, systemPromptTruncated: boolean): ContextManagementResult {
    const workingMessages = [...messages];
    let removedCount = 0;

    // Find the last user message
    const lastUserMessageIndex = this.findLastUserMessageIndex(workingMessages);

    if (lastUserMessageIndex !== -1) {
      // Keep only the last user message
      const lastUserMessage = workingMessages[lastUserMessageIndex];
      removedCount = workingMessages.length - 1;
      workingMessages.splice(0, workingMessages.length);
      workingMessages.push(lastUserMessage);
    } else {
      // Keep only the last message
      const lastMessage = workingMessages[workingMessages.length - 1];
      removedCount = workingMessages.length - 1;
      workingMessages.splice(0, workingMessages.length);

      if (lastMessage) {
        workingMessages.push(lastMessage);
      }
    }

    // If still too large, truncate the content of the remaining message
    if (workingMessages.length > 0) {
      const currentTokens = countMessagesTokens(workingMessages, this.options.model);

      if (currentTokens > availableTokens) {
        const message = workingMessages[0];
        const targetTokens = Math.floor(availableTokens * 0.8); // Use 80% of available tokens
        workingMessages[0] = this.truncateMessageContent(message, targetTokens);
      }
    }

    return {
      messages: workingMessages,
      systemPrompt: finalSystemPrompt,
      totalTokens: countMessagesTokens(workingMessages, this.options.model),
      truncated: true,
      removedMessages: removedCount,
      strategy: 'truncate-old',
      systemPromptTruncated,
    };
  }

  /**
   * Find the index of the last user message
   */
  private findLastUserMessageIndex(messages: Message[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        return i;
      }
    }
    return -1;
  }

  /**
   * Extreme truncation - last resort when everything else fails
   */
  private applyExtremeTruncation(messages: Message[], availableTokens: number, finalSystemPrompt: string, systemPromptTruncated: boolean): ContextManagementResult {
    logger.warn('Applying extreme truncation - this is a last resort');

    // Create a minimal message that fits
    const minimalMessage: Message = {
      id: 'emergency-' + Date.now(),
      role: 'user',
      content: 'Please continue with the previous conversation context.',
    };

    return {
      messages: [minimalMessage],
      systemPrompt: finalSystemPrompt,
      totalTokens: countMessagesTokens([minimalMessage], this.options.model),
      truncated: true,
      removedMessages: messages.length - 1,
      strategy: 'truncate-old',
      systemPromptTruncated,
    };
  }

  /**
   * Truncate message content to fit within token limit
   */
  private truncateMessageContent(message: Message, targetTokens: number): Message {
    if (typeof message.content !== 'string') {
      return message; // Can't easily truncate non-string content
    }

    const originalContent = message.content;
    const originalTokens = countMessageTokens(message, this.options.model);

    if (originalTokens <= targetTokens) {
      return message;
    }

    // Estimate how much content to keep (rough approximation)
    const keepRatio = targetTokens / originalTokens;
    const keepLength = Math.floor(originalContent.length * keepRatio * 0.9); // 90% to be safe

    const truncatedContent = originalContent.substring(0, keepLength) + '\n\n[Content truncated due to length...]';

    return {
      ...message,
      content: truncatedContent,
    };
  }

  /**
   * Truncate system prompt to fit within token limit
   */
  private truncateSystemPrompt(systemPrompt: string, maxTokens: number): string {
    const currentTokens = countTokens(systemPrompt, this.options.model);

    if (currentTokens <= maxTokens) {
      return systemPrompt;
    }

    logger.warn(`Truncating system prompt from ${currentTokens} to ${maxTokens} tokens`);

    // Calculate approximate character ratio
    const ratio = maxTokens / currentTokens;
    const targetLength = Math.floor(systemPrompt.length * ratio * 0.9); // 90% to be safe

    // Try to truncate at sentence boundaries
    let truncated = systemPrompt.substring(0, targetLength);

    // Find the last complete sentence
    const lastSentence = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const lastBoundary = Math.max(lastSentence, lastNewline);

    if (lastBoundary > targetLength * 0.7) {
      // If we found a good boundary, use it
      truncated = truncated.substring(0, lastBoundary + 1);
    }

    // Add truncation notice
    const truncationNotice = '\n\n[System prompt truncated to fit context window]';
    const noticeTokens = countTokens(truncationNotice, this.options.model);

    // Make sure we have room for the notice
    if (countTokens(truncated, this.options.model) + noticeTokens > maxTokens) {
      // Reduce further to make room for notice
      const adjustedRatio = (maxTokens - noticeTokens) / currentTokens;
      const adjustedLength = Math.floor(systemPrompt.length * adjustedRatio * 0.9);
      truncated = systemPrompt.substring(0, adjustedLength);

      // Try to find boundary again
      const adjustedLastSentence = truncated.lastIndexOf('.');
      const adjustedLastNewline = truncated.lastIndexOf('\n');
      const adjustedLastBoundary = Math.max(adjustedLastSentence, adjustedLastNewline);

      if (adjustedLastBoundary > adjustedLength * 0.7) {
        truncated = truncated.substring(0, adjustedLastBoundary + 1);
      }
    }

    return truncated + truncationNotice;
  }
}
