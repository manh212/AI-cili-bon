
import { useCallback, useEffect, useState } from 'react';
import { useChatStore } from '../store/chatStore';
import { useChatFlow } from './chat/useChatFlow';
import { useChatSession } from './useChatSession';
import { useChatMemory, countTotalTurns } from './useChatMemory';
import { useChatLogger } from './useChatLogger';
import { useChatInterface } from './chat/useChatInterface';
import { useMessageManipulator } from './chat/useMessageManipulator';
import { useChatCommands } from './chat/useChatCommands';
import { useLorebook } from '../contexts/LorebookContext'; 
import { getGlobalContextSettings } from '../services/settingsService';

/**
 * useChatEngine: A unified aggregator for chat state and logic.
 */
export const useChatEngine = (sessionId: string | null) => {
    const store = useChatStore();
    const logger = useChatLogger();
    const { lorebooks } = useLorebook(); 
    const { saveSession, changePreset } = useChatSession(sessionId);
    
    // sendMessage now supports forcedContent for Story Mode
    const { sendMessage, stopGeneration, interactiveError, handleUserDecision, manualMythicTrigger, processAIResponse } = useChatFlow(); 
    const { 
        isSummarizing, 
        triggerSmartContext, 
        handleRegenerateSummary, 
        handleRetryFailedTask,
        queueLength,
        summaryQueue
    } = useChatMemory();
    
    const { 
        deleteMessage, 
        deleteLastTurn, 
        editMessage 
    } = useMessageManipulator({ 
        saveSession, 
        card: store.card, 
        mergedSettings: store.mergedSettings, 
        logSystemMessage: logger.logSystemMessage,
        isBusy: store.isLoading || isSummarizing
    });
    
    const { 
        handleScriptButtonClick,
        isInputLocked,
        setIsInputLocked,
        isAutoLooping,
        setIsAutoLooping,
        quickReplies,
        scriptButtons
    } = useChatInterface({ logSystemMessage: logger.logSystemMessage });

    const { executeSlashCommands } = useChatCommands({
        card: store.card,
        persona: store.persona,
        saveSession,
        sendMessage,
        addSystemMessage: (content) => store.addMessage({ id: `sys-${Date.now()}`, role: 'system', content }),
        logSystemMessage: logger.logSystemMessage,
        updateVisualState: (type, value) => store.setSessionData({ visualState: { ...store.visualState, [type]: value } }),
        showToast: (msg) => console.log('Toast:', msg),
        showPopup: (content) => console.log('Popup:', content),
    });

    // --- STORY MODE LOGIC ---
    const isStoryMode = store.storyQueue && store.storyQueue.length > 0;

    const advanceStoryChunk = useCallback(async () => {
        if (!store.storyQueue || store.storyQueue.length === 0 || store.isLoading || isSummarizing) return;

        const nextChunk = store.storyQueue[0];
        const remainingQueue = store.storyQueue.slice(1);

        // 1. Trigger the Unified Pipeline (Snapshot -> Smart Scan -> Logic -> RPG)
        // We pass "Tiếp tục..." as the user trigger, and nextChunk as the forced AI response.
        await sendMessage("Tiếp tục...", { forcedContent: nextChunk });

        // 2. Update Queue & Save State
        store.setStoryQueue(remainingQueue);
        await saveSession({ storyQueue: remainingQueue });

        // REMOVED: Explicit Smart Context Check here.
        // It is now handled by the Global Watcher below.

    }, [store.storyQueue, store.isLoading, isSummarizing, sendMessage, saveSession, store.setStoryQueue]); // Reduced dependencies

    // --- GLOBAL WATCHER: AUTO SUMMARIZATION ---
    // Tự động theo dõi số lượt tin nhắn để kích hoạt tóm tắt
    // Hoạt động cho cả Chat thường và Story Mode
    useEffect(() => {
        // Chỉ chạy khi:
        // 1. Không đang tải (để đảm bảo tin nhắn cuối cùng đã hoàn tất)
        // 2. Không đang tóm tắt (tránh lặp)
        // 3. Có preset (để lấy cấu hình - though now we use Global)
        if (store.isLoading || isSummarizing || !store.preset) return;

        // FETCH FROM GLOBAL SETTINGS NOW
        const globalSettings = getGlobalContextSettings();
        const contextLimit = globalSettings.context_depth || 24;
        const chunkSize = globalSettings.summarization_chunk_size || 10;

        const totalTurns = countTotalTurns(store.messages);
        const summarizedTurns = store.longTermSummaries.length * chunkSize;
        const activeTurnCount = Math.max(0, totalTurns - summarizedTurns);

        // Nếu vượt quá giới hạn -> Tự động gọi tóm tắt
        if (activeTurnCount >= contextLimit) {
            triggerSmartContext();
        }

    }, [
        store.messages.length, // Chỉ chạy khi số lượng tin nhắn thay đổi (bot trả lời xong)
        store.isLoading, 
        isSummarizing, 
        store.preset, 
        store.longTermSummaries.length, 
        triggerSmartContext
    ]);


    // --- AUTO LOOP LOGIC (Story Mode - Synchronized) ---
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        
        // Điều kiện chạy Auto Loop:
        // 1. Phải đang bật AutoLoop và là Story Mode.
        // 2. KHÔNG đang tải (Loading) -> Chờ sendMessage/RPG xử lý xong.
        // 3. KHÔNG đang tóm tắt (Summarizing) -> Chờ bộ nhớ xử lý xong (QUAN TRỌNG).
        // 4. Không có lỗi.
        if (isAutoLooping && !store.isLoading && !isSummarizing && !store.error && isStoryMode) {
            timer = setTimeout(() => {
                advanceStoryChunk();
            }, 1000); // Fixed delay 1s
        }
        return () => clearTimeout(timer);
    }, [isAutoLooping, store.isLoading, isSummarizing, store.error, isStoryMode, advanceStoryChunk]);


    // --- REGENERATE LOGIC (SAFE STATE ROLLBACK) ---
    const regenerateLastResponse = useCallback(async () => {
        const msgs = store.messages;
        if (msgs.length === 0 || store.isLoading) return;

        let targetUserMsgId: string | null = null;
        let textToSend = "";
        let forceActiveUids: string[] | undefined = undefined;

        const lastMsg = msgs[msgs.length - 1];

        // Case 1: Last message is AI. We need to find the user message before it.
        if (lastMsg.role === 'model') {
            
            // --- NEW: EXTRACT ACTIVE UIDS BEFORE DELETING ---
            // This is the key optimization: Re-use the UIDs from the turn we are about to destroy.
            if (lastMsg.activeLorebookUids && lastMsg.activeLorebookUids.length > 0) {
                forceActiveUids = lastMsg.activeLorebookUids;
                logger.logSystemMessage('state', 'system', `[Regenerate] Snapshot found! Will reuse ${forceActiveUids.length} active entries (Skip Scan).`);
            }
            // ------------------------------------------------

            if (msgs.length >= 2) {
                const prev = msgs[msgs.length - 2];
                if (prev.role === 'user') {
                    targetUserMsgId = prev.id;
                    textToSend = prev.content;
                }
            }
        } 
        // Case 2: Last message is User (e.g., error case or manual stop).
        else if (lastMsg.role === 'user') {
            targetUserMsgId = lastMsg.id;
            textToSend = lastMsg.content;
        }

        if (targetUserMsgId && textToSend) {
            // 1. Rollback State (Variables, RPG, etc.) to BEFORE the user message
            await deleteMessage(targetUserMsgId);
            // 2. Re-send the message to trigger new generation
            // Pass the extracted UIDs to force reuse
            await sendMessage(textToSend, { forceActiveUids });
        } else {
            console.warn("Could not find a valid user message to regenerate from.");
        }
    }, [store.messages, store.isLoading, deleteMessage, sendMessage, logger]);

    return {
        // State
        ...store,
        isSummarizing,
        queueLength,
        summaryQueue,
        isInputLocked,
        isAutoLooping,
        quickReplies,
        scriptButtons,
        interactiveError, 
        isStoryMode, 

        // Actions
        sendMessage,
        regenerateLastResponse, 
        stopGeneration, 
        deleteMessage,
        deleteLastTurn,
        editMessage,
        saveSession,
        changePreset,
        triggerSmartContext,
        handleRegenerateSummary,
        handleRetryFailedTask,
        handleScriptButtonClick,
        executeSlashCommands,
        handleUserDecision, 
        handleRetryMythic: manualMythicTrigger,
        cancelStoryMode: store.clearStoryQueue, // Expose cancellation
        setError: store.setError, // EXPOSED: Allow UI to clear error manually
        
        // Specific Setters
        setIsAutoLooping,
        updateAuthorNote: (note: string) => store.setSessionData({ authorNote: note }),
        updateWorldInfoState: (state: Record<string, boolean>) => store.setSessionData({ worldInfoState: state }),
        updateWorldInfoPinned: (pinned: Record<string, boolean>) => store.setSessionData({ worldInfoPinned: pinned }),
        updateWorldInfoPlacement: (placement: Record<string, 'before' | 'after' | undefined>) => store.setSessionData({ worldInfoPlacement: placement }),
        updateVisualState: (type: 'bg' | 'music' | 'sound' | 'class', value: string) => 
            store.setSessionData({ visualState: { ...store.visualState, [type]: value } }),
        clearLogs: logger.clearLogs,
        
        // Story Mode Actions
        advanceStoryChunk
    };
};
