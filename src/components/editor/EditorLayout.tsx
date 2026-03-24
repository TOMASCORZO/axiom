'use client';

import Toolbar from './Toolbar';
import FileTree from './FileTree';
import AxiomViewport from './AxiomViewport';
import ChatPanel from './ChatPanel';
import ConsolePanel from './ConsolePanel';
import { useEditorStore } from '@/lib/store';

interface EditorLayoutProps {
    projectId: string;
}

export default function EditorLayout({ projectId }: EditorLayoutProps) {
    const { leftPanelWidth, rightPanelWidth, bottomPanelHeight } = useEditorStore();

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
                    {/* Center — Engine Viewport */}
                    <div className="flex-1 overflow-hidden">
                        <AxiomViewport />
                    </div>

                    {/* Bottom — Console Panel */}
                    <div
                        className="flex-shrink-0 overflow-hidden"
                        style={{ height: `${bottomPanelHeight}px` }}
                    >
                        <ConsolePanel />
                    </div>
                </div>

                {/* Right Panel — Chat */}
                <div
                    className="flex-shrink-0 border-l border-white/5 overflow-hidden"
                    style={{ width: `${rightPanelWidth}px` }}
                >
                    <ChatPanel projectId={projectId} />
                </div>
            </div>
        </div>
    );
}
