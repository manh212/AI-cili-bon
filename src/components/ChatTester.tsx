
import React, { useRef, useMemo, useEffect } from 'react';
import { useChatEngine } from '../hooks/useChatEngine';
import { useChatUI } from '../hooks/useChatUI'; // NEW Hook
import { useCharacter } from '../contexts/CharacterContext';
import { useUserPersona } from '../contexts/UserPersonaContext';
import { useLorebook } from '../contexts/LorebookContext';
import { ChatHeader } from './Chat/ChatHeader';
import { MessageList } from './Chat/MessageList';
import { ChatInput } from './Chat/ChatInput';
import { ChatLayout } from './Chat/ChatLayout';
import { VisualLayer } from './Chat/VisualLayer';
import { DebugPanel } from './Chat/DebugPanel';
import { Loader } from './Loader';
import { applyVariableOperation } from '../services/variableEngine'; 
import { countTotalTurns } from '../hooks/useChatMemory'; 
import { ChatOverlayManager } from './Chat/ChatOverlayManager'; 
import { RpgNotificationOverlay } from './Chat/RpgNotificationOverlay'; // NEW Import
import { getGlobalContextSettings } from '../services/settingsService'; // NEW Import

interface ChatTesterProps {
    sessionId: string;
    onBack: () => void;
}

export const ChatTester: React.FC<ChatTesterProps> = ({ sessionId, onBack }) => {
    // 1. Core Logic Hook
    const engine = useChatEngine(sessionId);
    
    // 2. UI State Hook
    const ui = useChatUI();

    // 3. Context Data
    const { characters } = useCharacter();
    const { activePersona } = useUserPersona();
    const { lorebooks } = useLorebook();

    const iframeRefs = useRef<Record<string, HTMLIFrameElement | null>>({});

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            engine.resetStore();
        };
    }, [engine.resetStore]);

    // --- Computed Data ---
    const characterAvatarUrl = useMemo(() => {
        if (!engine.card) return null;
        const charInContext = characters.find(c => c.fileName === engine.card!.fileName);
        return charInContext?.avatarUrl || null;
    }, [engine.card, characters]);

    const lastInteractiveMsg = useMemo(() => {
        const reversed = [...engine.messages].reverse();
        return reversed.find(m => m.interactiveHtml);
    }, [engine.messages]);

    // FIX: Calculate Active Turn Count using GLOBAL SETTINGS to match logic
    const globalContext = getGlobalContextSettings();
    const contextDepth = globalContext.context_depth || 24;
    const chunkSize = globalContext.summarization_chunk_size || 12;
    
    const activeTurnCount = useMemo(() => {
        const totalTurns = countTotalTurns(engine.messages);
        const summarizedTurns = engine.longTermSummaries.length * chunkSize;
        return Math.max(0, totalTurns - summarizedTurns);
    }, [engine.messages, engine.longTermSummaries.length, chunkSize]);

    const isInitializing = engine.isLoading && (!engine.card || !engine.preset);

    // --- Handlers ---
    const handleSaveEdit = () => {
        if (ui.editingMessageId) {
            engine.editMessage(ui.editingMessageId, ui.editingContent);
            ui.cancelEditing();
        }
    };

    const handleUpdateVariable = (key: string, value: any) => {
        try {
            const newVariables = applyVariableOperation(engine.variables, 'set', key, value);
            engine.setVariables(newVariables);
            engine.saveSession({ variables: newVariables });
        } catch (e) {
            console.error("Failed to update variable via Assistant:", e);
        }
    };

    const handleIframeLoad = (id: string) => {
        // Optional: Logic when iframe loads
    };

    // --- Render Guards ---
    if (isInitializing) {
        return (
            <div className="flex justify-center items-center h-full">
                <Loader message="Đang tải phiên trò chuyện..." />
            </div>
        );
    }

    // REMOVED BLOCKING ERROR SCREEN
    // Instead, we will pass engine.error to ChatInput to show a non-blocking alert

    if (!engine.card || !engine.preset) {
        return (
            <div className="flex flex-col justify-center items-center h-full gap-4 text-amber-400 bg-slate-900">
                <div className="p-6 bg-slate-800 rounded-xl shadow-lg border border-slate-700 max-w-md text-center">
                    <div className="text-4xl mb-4">🚫</div>
                    <p className="font-bold text-xl text-white mb-2">Dữ liệu không khả dụng</p>
                    <p className="text-slate-400 mb-6 text-sm">
                        Hệ thống không tìm thấy <strong>{(!engine.card ? 'Thẻ nhân vật' : '')} {(!engine.card && !engine.preset ? 'và' : '')} {(!engine.preset ? 'Preset' : '')}</strong> tương ứng.<br/>
                        <span className="text-xs opacity-75 mt-2 block">(Lỗi này thường xảy ra nếu bạn đã xóa file gốc sau khi tạo cuộc trò chuyện).</span>
                    </p>
                    <button onClick={onBack} className="w-full bg-slate-700 hover:bg-slate-600 text-white font-bold py-2 px-4 rounded-lg transition-colors">
                        Quay lại Sảnh
                    </button>
                </div>
            </div>
        );
    }

    return (
        <ChatLayout isImmersive={ui.isImmersive} globalClass={engine.visualState.globalClass}>
            <VisualLayer visualState={engine.visualState} isImmersive={ui.isImmersive} />
            
            {/* NEW: Persistent RPG Notification Overlay */}
            <RpgNotificationOverlay />

            <ChatHeader 
                characterName={engine.card.name}
                onBack={() => {
                    engine.saveSession({}, true); 
                    onBack();
                }}
                isImmersive={ui.isImmersive}
                setIsImmersive={ui.setIsImmersive}
                visualState={engine.visualState}
                onVisualUpdate={engine.updateVisualState}
                
                onToggleHUD={ui.toggleHUD}
                isHUDOpen={ui.isHUDOpen}
                onToggleStatusHUD={ui.toggleStatusHUD}
                isStatusHUDOpen={ui.isStatusHUDOpen}
                
                activePresetName={engine.preset.name}
                onPresetChange={engine.changePreset}
                
                onToggleAssistant={ui.toggleAssistant}
                isAssistantOpen={ui.isAssistantOpen}
                
                hasRpgData={!!engine.card.rpg_data}
                onToggleRpgDashboard={ui.toggleRpgDashboard}
                isRpgDashboardOpen={ui.isRpgDashboardOpen}
            />

            <MessageList 
                messages={engine.messages}
                isLoading={engine.isLoading}
                isImmersive={ui.isImmersive}
                characterName={engine.card.name}
                characterAvatarUrl={characterAvatarUrl}
                userPersonaName={activePersona?.name || 'User'}
                characterId={sessionId}
                sessionId={sessionId}
                
                editingMessageId={ui.editingMessageId}
                editingContent={ui.editingContent}
                setEditingContent={ui.setEditingContent}
                onStartEdit={ui.startEditing}
                onCancelEdit={ui.cancelEditing}
                onSaveEdit={handleSaveEdit}
                
                regenerateLastResponse={engine.regenerateLastResponse}
                deleteLastTurn={engine.deleteLastTurn}
                onDeleteMessage={engine.deleteMessage} 
                onOpenAuthorNote={() => ui.setIsAuthorNoteOpen(true)}
                onOpenWorldInfo={() => ui.setIsWorldInfoOpen(true)}
                
                scripts={engine.card.extensions?.TavernHelper_scripts || []}
                variables={engine.variables}
                extensionSettings={engine.extensionSettings}
                iframeRefs={iframeRefs}
                onIframeLoad={handleIframeLoad}
            />

            <ChatInput
                onSend={engine.sendMessage}
                onStop={engine.stopGeneration}
                isLoading={engine.isLoading}
                isImmersive={ui.isImmersive}
                quickReplies={engine.quickReplies}
                onQuickReplyClick={(qr) => engine.sendMessage(qr.message || qr.label)}
                scriptButtons={engine.scriptButtons}
                onScriptButtonClick={engine.handleScriptButtonClick}
                authorNote={engine.authorNote}
                onUpdateAuthorNote={engine.updateAuthorNote}
                isSummarizing={engine.isSummarizing}
                isInputLocked={engine.isInputLocked}
                isAutoLooping={engine.isAutoLooping} 
                onToggleAutoLoop={() => engine.setIsAutoLooping(!engine.isAutoLooping)} 
                queueLength={engine.queueLength} 
                // STORY MODE PROPS
                isStoryMode={engine.isStoryMode}
                storyQueueLength={engine.storyQueue ? engine.storyQueue.length : 0}
                onNextStoryChunk={engine.advanceStoryChunk}
                onCancelStoryMode={engine.cancelStoryMode}
                // ERROR HANDLING
                error={engine.error} // Pass error string
                onClearError={() => engine.setError(null)} // Pass clear handler
            >
                <DebugPanel 
                    logs={engine.logs} 
                    messages={engine.messages} // FIX: Pass full messages history for reconstruction
                    onClearLogs={engine.clearLogs} 
                    onInspectState={() => ui.setIsHUDOpen(true)} 
                    onCopyLogs={() => {}} 
                    copyStatus={false} 
                    isImmersive={ui.isImmersive}
                    onLorebookCreatorOpen={() => ui.setIsLorebookCreatorOpen(true)}
                    summaryStats={{
                        messageCount: activeTurnCount, // FIX: Pass Active Turns calculated from Global Settings
                        summaryCount: engine.longTermSummaries.length,
                        contextDepth: contextDepth,
                        chunkSize: chunkSize,
                        queueLength: engine.queueLength
                    }}
                    longTermSummaries={engine.longTermSummaries}
                    summaryQueue={engine.summaryQueue}
                    onForceSummarize={engine.triggerSmartContext}
                    onRegenerateSummary={engine.handleRegenerateSummary} 
                    onRetryFailedTask={engine.handleRetryFailedTask}
                    onRetryMythic={engine.handleRetryMythic} 
                />
            </ChatInput>

            <ChatOverlayManager
                ref={(el) => { if(el) iframeRefs.current['hud'] = el; }}
                uiState={ui}
                data={{
                    card: engine.card,
                    messages: engine.messages,
                    longTermSummaries: engine.longTermSummaries,
                    lorebooks,
                    authorNote: engine.authorNote,
                    worldInfoState: engine.worldInfoState,
                    worldInfoPinned: engine.worldInfoPinned,
                    worldInfoPlacement: engine.worldInfoPlacement,
                    variables: engine.variables,
                    logs: engine.logs,
                    lastInteractiveMsg,
                    characterAvatarUrl,
                    userPersonaName: activePersona?.name || 'User',
                    sessionId,
                    extensionSettings: engine.extensionSettings,
                    interactiveError: engine.interactiveError,
                    generatedLorebookEntries: engine.generatedLorebookEntries // NEW
                }}
                actions={{
                    updateAuthorNote: engine.updateAuthorNote,
                    updateWorldInfoState: engine.updateWorldInfoState,
                    updateWorldInfoPinned: engine.updateWorldInfoPinned,
                    updateWorldInfoPlacement: engine.updateWorldInfoPlacement,
                    handleUpdateVariable,
                    handleRewriteLastTurn: engine.editMessage,
                    handleUserDecision: engine.handleUserDecision
                }}
            />
        </ChatLayout>
    );
};
