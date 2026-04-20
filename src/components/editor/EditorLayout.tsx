'use client';

import Toolbar from './Toolbar';
import FileTree from './FileTree';
import AxiomViewport from './AxiomViewport';
import AssetPreview from './AssetPreview';
import CodeEditor from './CodeEditor';
import ChatPanel from '@/components/chat/ChatPanel';
import AssetStudio from './AssetStudio';
import MapStudio from './MapStudio';
import MapCanvas from './MapCanvas';
import DatabaseStudio from './DatabaseStudio';
import RealtimeStudio from './RealtimeStudio';
import ConsolePanel from './ConsolePanel';
import SubsystemsPanel from './SubsystemsPanel';
import AnimationTimeline from './AnimationTimeline';
import HierarchyPanel from './HierarchyPanel';
import InspectorPanel from './InspectorPanel';
import { useEditorStore } from '@/lib/store';

interface EditorLayoutProps {
    projectId: string;
}

export default function EditorLayout({ projectId }: EditorLayoutProps) {
    const { leftPanelWidth, rightPanelWidth, bottomPanelHeight, openFiles, activeRightPanel, selectedNodePath } = useEditorStore();
    const hasOpenFiles = openFiles.length > 0;
    const showInspector = selectedNodePath !== null && activeRightPanel === 'chat';

    return (
        <div className="h-screen w-screen flex flex-col bg-zinc-950 text-white overflow-hidden">
            {/* Toolbar */}
            <Toolbar />

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left Panel — File Tree + Scene Hierarchy */}
                <div
                    className="flex-shrink-0 border-r border-white/5 overflow-hidden flex flex-col"
                    style={{ width: `${leftPanelWidth}px` }}
                >
                    <div className="flex-1 overflow-hidden min-h-0" style={{ flex: '1 1 50%' }}>
                        <FileTree projectId={projectId} />
                    </div>
                    <div className="flex-1 overflow-hidden min-h-0 border-t border-white/5" style={{ flex: '1 1 50%' }}>
                        <HierarchyPanel />
                    </div>
                </div>

                {/* Center + Bottom */}
                <div className="flex-1 flex flex-col overflow-hidden relative">
                    {/* Center — Asset Preview / Map Canvas / Code Editor + Viewport */}
                    <div className="flex-1 flex flex-col overflow-hidden">
                        {activeRightPanel === 'maps' ? (
                            <div className="flex-1 overflow-hidden">
                                <MapCanvas />
                            </div>
                        ) : activeRightPanel === 'assets' ? (
                            <div className="flex-1 overflow-hidden">
                                <AssetPreview />
                            </div>
                        ) : activeRightPanel === 'database' ? (
                            <div className="flex-1 overflow-hidden">
                                <AxiomViewport />
                            </div>
                        ) : hasOpenFiles ? (
                            <>
                                <div className="flex-1 overflow-hidden min-h-0" style={{ flex: '1 1 50%' }}>
                                    <CodeEditor />
                                </div>
                                <div className="flex-1 overflow-hidden min-h-0 border-t border-white/5" style={{ flex: '1 1 50%' }}>
                                    <AxiomViewport />
                                </div>
                            </>
                        ) : (
                            <div className="flex-1 overflow-hidden">
                                <AxiomViewport />
                            </div>
                        )}
                    </div>

                    {/* Inspector — floating overlay over the viewport when a node is selected */}
                    {showInspector && (
                        <div className="absolute top-0 right-0 bottom-0 w-[320px] border-l border-white/5 shadow-[-8px_0_24px_rgba(0,0,0,0.3)] z-20 bg-zinc-950/95 backdrop-blur-sm">
                            <InspectorPanel />
                        </div>
                    )}

                    {/* Bottom — Console + Subsystems / Animation Timeline / hidden for maps */}
                    <div
                        className="flex-shrink-0 overflow-hidden flex flex-col"
                        style={{ height: activeRightPanel === 'maps' ? 0 : `${bottomPanelHeight}px` }}
                    >
                        {activeRightPanel === 'assets' ? (
                            <div className="flex-1 overflow-hidden">
                                <AnimationTimeline />
                            </div>
                        ) : activeRightPanel === 'maps' ? null : (
                            <>
                                <div className="flex-1 overflow-hidden">
                                    <ConsolePanel />
                                </div>
                                <div className="flex-shrink-0 max-h-[200px] overflow-hidden">
                                    <SubsystemsPanel />
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Right Panel — Chat or Asset Studio */}
                <div
                    className="flex-shrink-0 border-l border-white/5 overflow-hidden"
                    style={{ width: `${rightPanelWidth}px` }}
                >
                    {activeRightPanel === 'assets' ? (
                        <AssetStudio />
                    ) : activeRightPanel === 'maps' ? (
                        <MapStudio />
                    ) : activeRightPanel === 'database' ? (
                        <DatabaseStudio />
                    ) : activeRightPanel === 'realtime' ? (
                        <RealtimeStudio />
                    ) : (
                        <ChatPanel projectId={projectId} />
                    )}
                </div>
            </div>
        </div>
    );
}
