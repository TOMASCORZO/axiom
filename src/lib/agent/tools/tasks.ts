/**
 * Task Management Tools — Ported from Claude Code
 * 
 * Provides TaskCreateTool, TaskGetTool, TaskUpdateTool, and TaskListTool.
 * Persists tasks in-project via a hidden .axiom_tasks.json file in Supabase.
 */

import { registerTool, type ToolContext, type ToolInput } from './registry';
import { getAdminClient as getAdmin } from '@/lib/supabase/admin';

const TASKS_FILE = '.axiom_tasks.json';

interface Task {
    id: string;
    subject: string;
    description: string;
    activeForm?: string;
    status: 'pending' | 'in_progress' | 'completed' | 'blocked';
    owner?: string;
}

async function loadTasks(projectId: string): Promise<Task[]> {
    const { data } = await getAdmin()
        .from('project_files')
        .select('text_content')
        .eq('project_id', projectId)
        .eq('path', TASKS_FILE)
        .single();
    if (!data?.text_content) return [];
    try {
        return JSON.parse(data.text_content) as Task[];
    } catch {
        return [];
    }
}

async function saveTasks(projectId: string, tasks: Task[]): Promise<void> {
    const content = JSON.stringify(tasks, null, 2);
    const sizeBytes = new TextEncoder().encode(content).length;
    await getAdmin().from('project_files').upsert({
        project_id: projectId,
        path: TASKS_FILE,
        content_type: 'application/json',
        text_content: content,
        size_bytes: sizeBytes,
        updated_at: new Date().toISOString(),
    }, { onConflict: 'project_id,path' });
}

function generateTaskId(): string {
    return Math.random().toString(36).substring(2, 8);
}

// ── TaskCreateTool ──────────────────────────────────────────────────

registerTool({
    name: 'TaskCreateTool',
    description: "Create a new task in the task list.\n\nUsage:\n- Use this tool proactively for complex multi-step tasks, non-trivial planning, or when the user provides multiple tasks.\n- Do NOT use for single, straightforward tasks.\n- All tasks are created with status 'pending'.",
    parameters: {
        type: 'object',
        properties: {
            subject: { type: 'string', description: 'Brief, actionable title in imperative form' },
            description: { type: 'string', description: 'Detailed explanation of what needs to be done' },
            activeForm: { type: 'string', description: 'Present continuous form shown in the spinner (optional)' },
        },
        required: ['subject', 'description'],
    },
    access: ['build', 'plan'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const tasks = await loadTasks(ctx.projectId);
        const newTask: Task = {
            id: generateTaskId(),
            subject: input.subject as string,
            description: input.description as string,
            activeForm: input.activeForm as string | undefined,
            status: 'pending',
        };
        tasks.push(newTask);
        await saveTasks(ctx.projectId, tasks);
        // We notify the UI through the output format
        return {
            success: true,
            output: {
                __interactive: true,
                type: 'task_created',
                task: newTask,
                message: "Created task: " + newTask.subject
            },
            duration_ms: 0,
        };
    },
});

// ── TaskListTool ────────────────────────────────────────────────────

registerTool({
    name: 'TaskListTool',
    description: "List all existing tasks in the current session. Use this to check progress or avoid duplicating tasks.",
    parameters: {
        type: 'object',
        properties: {
            status: { type: 'string', description: 'Filter by status (pending, in_progress, etc). Optional.' },
        },
        required: [],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const tasks = await loadTasks(ctx.projectId);
        let filtered = tasks;
        if (input.status) {
            filtered = tasks.filter(t => t.status === input.status);
        }
        return {
            success: true,
            output: { tasks: filtered, count: filtered.length },
            duration_ms: 0,
        };
    },
});

// ── TaskGetTool ─────────────────────────────────────────────────────

registerTool({
    name: 'TaskGetTool',
    description: "Get detailed information about a specific task by its ID.",
    parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Task ID' } },
        required: ['id'],
    },
    access: ['build', 'plan', 'explore'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const tasks = await loadTasks(ctx.projectId);
        const task = tasks.find(t => t.id === input.id);
        if (!task) return { success: false, output: null, error: "Task not found: " + input.id, duration_ms: 0 };
        return { success: true, output: { task }, duration_ms: 0 };
    },
});

// ── TaskUpdateTool ──────────────────────────────────────────────────

registerTool({
    name: 'TaskUpdateTool',
    description: "Update an existing task's status, assignment, or description.\nUse this before starting work (mark as in_progress) and after finishing (mark as completed).",
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'Task ID' },
            status: { type: 'string', description: "New status: 'pending', 'in_progress', 'completed', or 'blocked'" },
            description: { type: 'string', description: 'Updated description' },
            owner: { type: 'string', description: 'Assign to a specific owner or agent' },
        },
        required: ['id'],
    },
    access: ['build', 'plan'],
    async execute(ctx: ToolContext, input: ToolInput) {
        const tasks = await loadTasks(ctx.projectId);
        const index = tasks.findIndex(t => t.id === input.id);
        if (index === -1) return { success: false, output: null, error: "Task not found: " + input.id, duration_ms: 0 };
        
        const task = tasks[index];
        if (input.status) task.status = input.status as Task['status'];
        if (input.description) task.description = input.description as string;
        if (input.owner) task.owner = input.owner as string;
        
        await saveTasks(ctx.projectId, tasks);
        
        return {
            success: true,
            output: {
                __interactive: true,
                type: 'task_updated',
                task,
                message: "Updated task [" + task.id + "] status to " + task.status
            },
            duration_ms: 0,
        };
    },
});
