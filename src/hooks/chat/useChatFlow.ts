
import { useCallback, useState, useRef } from 'react';
import { useChatStore } from '../../store/chatStore';
import { useResponseHandler } from './useResponseHandler';
import { constructChatPrompt, prepareChat } from '../../services/promptManager';
import { sendChatRequestStream, sendChatRequest } from '../../services/geminiService';
import { useLorebook } from '../../contexts/LorebookContext';
import { useChatLogger } from '../useChatLogger';
import { useWorldSystem } from '../useWorldSystem';
import { MedusaService, syncDatabaseToLorebook, parseCustomActions, applyMedusaActions } from '../../services/medusaService'; 
import { getApiKey, getGlobalContextSettings, getConnectionSettings } from '../../services/settingsService';
import { useToast } from '../../components/ToastSystem';
import type { WorldInfoEntry, InteractiveErrorState, ChatMessage } from '../../types';
import { countTotalTurns } from '../useChatMemory';

export const useChatFlow = () => {
    const state = useChatStore();
    const { processAIResponse, createPlaceholderMessage } = useResponseHandler();
    const { lorebooks } = useLorebook();
    const logger = useChatLogger();
    const { scanInput } = useWorldSystem(state.card);
    const { showToast } = useToast();

    // --- INTERACTIVE ERROR STATE ---
    const [interactiveError, setInteractiveError] = useState<InteractiveErrorState>({
        hasError: false,
        title: '',
        message: '',
        canIgnore: true
    });
    
    // Resolver ref để giữ hàm resolve của Promise khi tạm dừng
    const errorResolverRef = useRef<((decision: 'retry' | 'ignore') => void) | null>(null);

    // --- SOUND NOTIFICATION SYSTEM ---
    const playNotification = useCallback((type: 'ai' | 'rpg') => {
        const { visualState } = useChatStore.getState(); // Always get fresh visual state
        if (visualState.systemSoundEnabled === false) return;

        let soundUrl = '';
        if (type === 'ai') soundUrl = visualState.aiSoundUrl || '';
        if (type === 'rpg') soundUrl = visualState.rpgSoundUrl || '';

        if (soundUrl) {
            const audio = new Audio(soundUrl);
            audio.volume = 0.5;
            audio.play().catch(e => console.warn('Sound play error:', e));
        } else {
            // Fallback beep logic...
        }
    }, []);

    const waitForUserDecision = useCallback((title: string, message: string, errorDetails: any, canIgnore: boolean = true): Promise<'retry' | 'ignore'> => {
        return new Promise((resolve) => {
            const errorStr = errorDetails instanceof Error ? errorDetails.message : String(errorDetails);
            setInteractiveError({ hasError: true, title, message, errorDetails: errorStr, canIgnore });
            errorResolverRef.current = resolve;
        });
    }, []);

    const handleUserDecision = useCallback((decision: 'retry' | 'ignore') => {
        setInteractiveError(prev => ({ ...prev, hasError: false }));
        if (errorResolverRef.current) {
            errorResolverRef.current(decision);
            errorResolverRef.current = null;
        }
    }, []);

    const stopGeneration = useCallback(() => {
        const freshState = useChatStore.getState();
        if (freshState.abortController) {
            freshState.abortController.abort();
            state.setAbortController(null);
            state.setLoading(false);
            logger.logSystemMessage('interaction', 'system', 'Người dùng đã dừng quá trình tạo.');
        }
    }, [state, logger]);

    // --- SHARED POST-PROCESSING LOGIC (Used by both Chat & Arena Selection) ---
    const runPostProcessing = useCallback(async (
        textResponse: string, 
        messageId: string, 
        isStoryModeChunk: boolean = false
    ) => {
        const freshState = useChatStore.getState();
        const aiMsg = freshState.messages.find(m => m.id === messageId);
        if (!aiMsg) return;

        // 1. Variable Engine & Regex Processing
        const cleanResponse = textResponse ? textResponse.trim() : "";
        const wordCount = cleanResponse.split(/\s+/).filter(w => w.length > 0).length;

        if (!cleanResponse || (cleanResponse.length < 100 && wordCount < 10)) {
            logger.logSystemMessage('warn', 'system', `Phản hồi ngắn (${wordCount} từ). Mythic Engine có thể không hoạt động chính xác.`);
        }

        await processAIResponse(cleanResponse, messageId);
        logger.logResponse(cleanResponse);
        
        if (!isStoryModeChunk) {
            playNotification('ai');
        }

        // 2. Mythic Engine (RPG Logic)
        const executionMode = freshState.card?.rpg_data?.settings?.executionMode || 'standalone';
        const snapshotForAction = aiMsg.rpgSnapshot;
        const currentTurn = countTotalTurns(freshState.messages);

        // --- INTEGRATED MODE LOGIC (1-PASS) ---
        if (freshState.card?.rpg_data && executionMode === 'integrated') {
            const actions = parseCustomActions(cleanResponse, snapshotForAction);
            
            if (actions.length > 0) {
                logger.logSystemMessage('state', 'system', `[Integrated RPG] Detected ${actions.length} actions.`);
                const { newDb, notifications, logs } = applyMedusaActions(freshState.card.rpg_data, actions);
                
                const updatedCard = { ...freshState.card, rpg_data: newDb };
                state.setSessionData({ card: updatedCard });
                state.updateMessage(messageId, { rpgState: newDb });
                
                if (logs.length > 0) logger.logSystemMessage('script-success', 'system', `[RPG Update]:\n${logs.join('\n')}`);
                
                if (notifications.length > 0) {
                    const notificationText = notifications.join('\n');
                    state.setRpgNotification(notificationText);
                    playNotification('rpg');
                } else {
                    state.setRpgNotification(null);
                }
                
                const generatedEntries = syncDatabaseToLorebook(newDb);
                state.setGeneratedLorebookEntries(generatedEntries);
                
                // Update Runtime Stats (Last Active Turn)
                const nextRuntime = { ...freshState.worldInfoRuntime };
                actions.forEach(action => {
                     if (action.type === 'UPDATE' && action.rowId && typeof action.tableIndex === 'number') {
                        const table = newDb.tables[action.tableIndex];
                        if (table) {
                            const uid = `mythic_${table.config.id}_${action.rowId}`;
                            if (nextRuntime[uid]) {
                                nextRuntime[uid] = { ...nextRuntime[uid], lastActiveTurn: currentTurn };
                            }
                        }
                     }
                });
                state.setSessionData({ worldInfoRuntime: nextRuntime });

            } else {
                logger.logSystemMessage('log', 'system', '[Integrated RPG] No actions found in response.');
            }
        }
        
        // --- STANDALONE MODE LOGIC (2-PASS) ---
        else if (freshState.card?.rpg_data && executionMode === 'standalone') {
            logger.logSystemMessage('state', 'system', 'Mythic Engine: Đang kích hoạt Medusa (Standalone)...');
            const apiKey = getApiKey();
            
            if (apiKey) {
                // Logic xử lý Standalone Medusa (đã rút gọn để tái sử dụng, logic giống bản cũ)
                // Trong thực tế, bạn nên tách hàm MedusaService.processTurn ra ngoài
                // Ở đây chúng ta gọi lại logic tương tự như trong sendMessage cũ nhưng sử dụng textResponse
                
                // Construct History Log manually since we are post-generation
                let historyLog = `System/GM: ${cleanResponse}`;
                const userMsg = freshState.messages[freshState.messages.length - 2]; // User message is usually before AI
                if (userMsg && userMsg.role === 'user') {
                    historyLog = `User: ${userMsg.content}\n${historyLog}`;
                }

                // ... (Các bước chuẩn bị entry như cũ) ...
                let allEntries: WorldInfoEntry[] = freshState.card.char_book?.entries || [];
                lorebooks.forEach(lb => {
                    if (lb.book?.entries) allEntries = [...allEntries, ...lb.book.entries];
                });
                
                // Active entries from the message state if available
                const activeUids = aiMsg.activeLorebookUids || [];
                const dynamicActiveEntries = allEntries.filter(e => e.uid && activeUids.includes(e.uid) && !e.constant);
                const maxTokens = Number(freshState.preset?.max_tokens) || 16384;

                try {
                    const medusaResult = await MedusaService.processTurn(
                        historyLog,
                        freshState.card.rpg_data,
                        apiKey,
                        dynamicActiveEntries,
                        allEntries,
                        'gemini-flash-lite-latest',
                        maxTokens
                    );

                    if (medusaResult.success) {
                        const updatedCard = { ...freshState.card, rpg_data: medusaResult.newDb };
                        state.setSessionData({ card: updatedCard });
                        state.updateMessage(messageId, { rpgState: medusaResult.newDb });
                        
                        if (medusaResult.logs?.length > 0) logger.logSystemMessage('script-success', 'system', `[RPG Update]:\n${medusaResult.logs.join('\n')}`);
                        if (medusaResult.notifications?.length > 0) {
                            state.setRpgNotification(medusaResult.notifications.join('\n'));
                            playNotification('rpg');
                        }
                        
                        const generatedEntries = syncDatabaseToLorebook(medusaResult.newDb);
                        state.setGeneratedLorebookEntries(generatedEntries);
                    }
                } catch (e: any) {
                    logger.logSystemMessage('error', 'system', `Mythic Engine Error: ${e.message}`);
                }
            }
        }

    }, [state, lorebooks, logger, processAIResponse, playNotification]);


    // --- ARENA SELECTION HANDLER (FIX FOR ISSUE #1) ---
    const handleArenaSelection = useCallback(async (messageId: string, selection: 'A' | 'B') => {
        const freshState = useChatStore.getState();
        const msg = freshState.messages.find(m => m.id === messageId);
        
        if (!msg || !msg.arena) return;

        const selectedContent = selection === 'A' ? msg.arena.modelA.content : msg.arena.modelB.content;
        const selectedModelName = selection === 'A' ? msg.arena.modelA.name : msg.arena.modelB.name;

        // 1. Update UI immediately
        state.updateMessage(messageId, {
            content: selectedContent,
            arena: {
                ...msg.arena,
                selected: selection
            }
        });

        logger.logSystemMessage('interaction', 'system', `Arena: Người dùng chọn ${selection} (${selectedModelName}). Bắt đầu xử lý logic...`);

        // 2. Run Post-Processing (Variable + RPG Updates)
        state.setLoading(true);
        try {
            await runPostProcessing(selectedContent, messageId, false);
        } finally {
            state.setLoading(false);
            // 3. Save Session
            // Note: runPostProcessing modifies store, but we trigger explicit save here just in case
            // The hook in useChatSession watches 'messages' so it might auto-save, but safer to be sure.
        }

    }, [state, logger, runPostProcessing]);


    // --- MANUAL MYTHIC TRIGGER ---
    const manualMythicTrigger = useCallback(async () => {
        const freshState = useChatStore.getState();
        if (!freshState.card?.rpg_data) {
            showToast('Không tìm thấy dữ liệu RPG.', 'warning');
            return;
        }

        // Find last AI message
        const lastAiMsg = [...freshState.messages].reverse().find(m => m.role === 'model');
        if (!lastAiMsg) return;

        state.setLoading(true);
        try {
            // Re-run post processing just for the RPG part basically
            // Since runPostProcessing handles idempotency reasonably well, we can reuse it
             await runPostProcessing(lastAiMsg.content, lastAiMsg.id, false);
             
        } finally {
            state.setLoading(false);
        }
    }, [state, showToast, runPostProcessing]);


    // --- UNIFIED SEND MESSAGE ---
    const sendMessage = useCallback(async (text: string, options?: { forcedContent?: string, forceActiveUids?: string[] }) => {
        const freshState = useChatStore.getState();
        if (!freshState.card || !freshState.preset || !text.trim()) return;

        state.setError(null);
        state.setLoading(true);
        logger.startTurn();

        const ac = new AbortController();
        state.setAbortController(ac);

        const currentTurn = countTotalTurns(freshState.messages) + 1;
        
        // Snapshots
        const currentVariablesSnapshot = JSON.parse(JSON.stringify(freshState.variables));
        const currentRpgSnapshot = freshState.card.rpg_data ? JSON.parse(JSON.stringify(freshState.card.rpg_data)) : undefined;
        const currentWIRuntimeSnapshot = JSON.parse(JSON.stringify(freshState.worldInfoRuntime));
        const currentWIStateSnapshot = JSON.parse(JSON.stringify(freshState.worldInfoState));
        
        const userMsg: ChatMessage = { 
            id: `u-${Date.now()}`, 
            role: 'user', 
            content: text, 
            timestamp: Date.now(),
            contextState: currentVariablesSnapshot,
            rpgState: currentRpgSnapshot,
            worldInfoRuntime: currentWIRuntimeSnapshot,
            worldInfoState: currentWIStateSnapshot
        };
        state.addMessage(userMsg);

        try {
            // ... (Smart Scan Logic) ...
             const dynamicEntries = freshState.generatedLorebookEntries || [];
             const messagesForScan = [...freshState.messages]; 
             const recentHistoryText = messagesForScan.slice(-3).map(m => m.content).join('\n');
             const textToScan = options?.forcedContent ? `${recentHistoryText}\n${text}\n${options.forcedContent}` : `${recentHistoryText}\n${text}`;
             const historyList = messagesForScan.map(m => m.content).slice(-3);
             
             let scanResult;
             try {
                scanResult = await scanInput(
                    textToScan, freshState.worldInfoState, freshState.worldInfoRuntime, freshState.worldInfoPinned,
                    freshState.preset, historyList, text, freshState.variables, dynamicEntries, currentTurn, options?.forceActiveUids
                );
             } catch(e) { scanResult = { activeEntries: [], updatedRuntimeState: freshState.worldInfoRuntime }; }

             state.setSessionData({ worldInfoRuntime: scanResult.updatedRuntimeState });
             logger.logWorldInfo(scanResult.activeEntries);
             // ---------------------------------------------------------

            // 5. Construct Prompt
            let fullPrompt = "";
            let generatedRpgSnapshot;

            if (!options?.forcedContent) {
                const sessionLorebook = { name: "Session Generated", book: { entries: dynamicEntries } };
                const effectiveLorebooks = [...lorebooks, sessionLorebook];
                const { baseSections } = prepareChat(freshState.card, freshState.preset, effectiveLorebooks, freshState.persona);
                const globalContext = getGlobalContextSettings();
                const chunkSize = globalContext.summarization_chunk_size || 12;

                const constructed = await constructChatPrompt(
                    baseSections, [...freshState.messages, userMsg], freshState.authorNote,
                    freshState.card, freshState.longTermSummaries, chunkSize, freshState.variables, 
                    freshState.lastStateBlock, effectiveLorebooks, freshState.preset.context_mode || 'standard',
                    freshState.persona?.name || 'User', freshState.worldInfoState,
                    scanResult.activeEntries, freshState.worldInfoPlacement, freshState.preset
                );
                fullPrompt = constructed.fullPrompt;
                generatedRpgSnapshot = constructed.rpgSnapshot;
                logger.logPrompt(constructed.structuredPrompt);
            }

            // 6. Create AI Placeholder
            const aiMsg = createPlaceholderMessage('model');
            aiMsg.rpgState = currentRpgSnapshot;
            aiMsg.worldInfoRuntime = scanResult.updatedRuntimeState;
            aiMsg.rpgSnapshot = generatedRpgSnapshot;
            aiMsg.activeLorebookUids = scanResult.activeEntries.map(e => e.uid).filter(Boolean) as string[];

            // Arena Init Logic
            if (freshState.isArenaMode && freshState.arenaModelId && !options?.forcedContent) {
                // Determine the correct Model A (Current Settings)
                const connection = getConnectionSettings();
                const modelA_ID = connection.source === 'gemini' ? connection.gemini_model : 
                                  (connection.source === 'proxy' ? connection.proxy_model : connection.openrouter_model);
                
                aiMsg.arena = {
                    enabled: true,
                    modelA: { name: modelA_ID || 'Model A', content: '' },
                    modelB: { name: freshState.arenaModelId, content: '' },
                    selected: null
                };
                aiMsg.content = ""; // Empty content until selection
            }

            state.addMessage(aiMsg);

            // 7. Execution
            let accumulatedText = "";

            if (options?.forcedContent) {
                accumulatedText = options.forcedContent;
                state.updateMessage(aiMsg.id, { content: accumulatedText });
                // For Story Mode, we trigger post-processing immediately
                if (!ac.signal.aborted) {
                    await runPostProcessing(accumulatedText, aiMsg.id, true);
                }
            } else {
                if (freshState.isArenaMode && freshState.arenaModelId) {
                    // --- ARENA PARALLEL EXECUTION ---
                    const connection = getConnectionSettings();
                    const modelA_ID = connection.source === 'gemini' ? connection.gemini_model : 
                                      (connection.source === 'proxy' ? connection.proxy_model : connection.openrouter_model);
                    const modelB_ID = freshState.arenaModelId;
                    
                    const runStream = async (modelId: string, slot: 'modelA' | 'modelB') => {
                        let slotContent = "";
                        try {
                            const stream = sendChatRequestStream(fullPrompt, freshState.preset!, ac.signal, modelId);
                            for await (const chunk of stream) {
                                if (ac.signal.aborted) break;
                                slotContent += chunk;
                                const currentMsg = useChatStore.getState().messages.find(m => m.id === aiMsg.id);
                                if (currentMsg && currentMsg.arena) {
                                    const newArena = { ...currentMsg.arena };
                                    newArena[slot].content = slotContent;
                                    state.updateMessage(aiMsg.id, { arena: newArena });
                                }
                            }
                        } catch (e: any) {
                             // Independent error handling for each slot
                             const currentMsg = useChatStore.getState().messages.find(m => m.id === aiMsg.id);
                             if (currentMsg && currentMsg.arena) {
                                 const newArena = { ...currentMsg.arena };
                                 newArena[slot].content = `[Lỗi: ${e.message}]`;
                                 state.updateMessage(aiMsg.id, { arena: newArena });
                             }
                        }
                    };

                    await Promise.all([
                        runStream(modelA_ID, 'modelA'),
                        runStream(modelB_ID, 'modelB')
                    ]);
                    
                    playNotification('ai');
                    // DO NOT run post-processing here. Wait for user selection.
                    
                } else {
                    // --- STANDARD EXECUTION ---
                    const shouldStream = freshState.preset.stream_response;
                    if (shouldStream) {
                        const stream = sendChatRequestStream(fullPrompt, freshState.preset, ac.signal);
                        for await (const chunk of stream) {
                            if (ac.signal.aborted) break;
                            accumulatedText += chunk;
                            state.updateMessage(aiMsg.id, { content: accumulatedText + " ▌" });
                        }
                        // Remove cursor
                        state.updateMessage(aiMsg.id, { content: accumulatedText });
                    } else {
                        state.updateMessage(aiMsg.id, { content: "..." });
                        const result = await sendChatRequest(fullPrompt, freshState.preset);
                        accumulatedText = result.response.text || "";
                        state.updateMessage(aiMsg.id, { content: accumulatedText });
                    }

                    // TRIGGER POST PROCESSING
                    if (!ac.signal.aborted) {
                        await runPostProcessing(accumulatedText, aiMsg.id, false);
                    }
                }
            }

        } catch (err: any) {
            if (err.message !== 'Aborted') {
                console.error(err);
                state.setError(`Lỗi: ${err.message}`);
                logger.logSystemMessage('api-error', 'api', err.message);
            }
        } finally {
            state.setLoading(false);
            state.setAbortController(null);
        }
    }, [state, lorebooks, createPlaceholderMessage, logger, scanInput, showToast, waitForUserDecision, playNotification, runPostProcessing]); 

    return { 
        sendMessage, 
        stopGeneration,
        interactiveError,
        handleUserDecision,
        manualMythicTrigger,
        processAIResponse,
        handleArenaSelection // EXPORT NEW FUNCTION
    };
};
