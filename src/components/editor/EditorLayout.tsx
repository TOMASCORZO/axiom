'use client';

import Toolbar from './Toolbar';
import FileTree from './FileTree';
import AxiomViewport from './AxiomViewport';
import AssetPreview from './AssetPreview';
import CodeEditor from './CodeEditor';
import ChatPanel from '@/components/chat/ChatPanel';
import AssetStudio from './AssetStudio';
import ConsolePanel from './ConsolePanel';
import SubsystemsPanel from './SubsystemsPanel';
import AnimationTimeline from './AnimationTimeline';
import { useEditorStore } from '@/lib/store';

interface EditorLayoutProps {
    projectId: string;
}

export default function EditorLayout({ projectId }: EditorLayoutProps) {
    const { leftPanelWidth, rightPanelWidth, bottomPanelHeight, openFiles, activeRightPanel } = useEditorStore();
    const hasOpenFiles = openFiles.length > 0;

    return (
        <div className="h-screen w-screen flex flex-col bg-zinc-950 text-white overflow-hidden">
            {/* Toolbar */}
            <Toolbar />

            {/* Main Content */}
            <div className="flex-1 flex overflow-hidden">
                {/* Left Panel — File Tree */}
                <div
                    className="flex-shrink-0 border-r border-white/5 overflow-hidden"
                    style={{ width: `${leftPanelWidth}px` }}
                >
                    <FileTree projectId={projectId} />
                </div>

                {/* Center + Bottom */}
                <div className="flex-1 flex flex-col overflow-hidden">
                    {/* Center — split between Code Editor and Engine Viewport / Asset Preview */}
                    <div className="flex-1 flex flex-col overflow-hidden">
                        {hasOpenFiles ? (
                            <>
                                {/* Code Editor — top half */}
                                <div className="flex-1 overflow-hidden min-h-0" style={{ flex: '1 1 50%' }}>
                                    <CodeEditor />
                                </div>
                                {/* Engine Viewport or Asset Preview — bottom half */}
                                <div className="flex-1 overflow-hidden min-h-0 border-t border-white/5" style={{ flex: '1 1 50%' }}>
                                    {activeRightPanel === 'assets' ? <AssetPreview /> : <AxiomViewport />}
                                </div>
                            </>
                        ) : (
                            /* No files open — full center */
                            <div className="flex-1 overflow-hidden">
                                {activeRightPanel === 'assets' ? <AssetPreview /> : <AxiomViewport />}
                            </div>
                        )}
                    </div>

                    {/* Bottom — Console + Subsystems OR Animation Timeline */}
                    <div
                        className="flex-shrink-0 overflow-hidden flex flex-col"
                        style={{ height: `${bottomPanelHeight}px` }}
                    >
                        {activeRightPanel === 'assets' ? (
                            <div className="flex-1 overflow-hidden">
                                <AnimationTimeline />
                            </div>
                        ) : (
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
                    ) : (
                        <ChatPanel projectId={projectId} />
                    )}
                </div>
            </div>
        </div>
    );
}
