import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';

// GET /api/projects — List user's projects
export async function GET() {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { data: projects, error } = await supabase
            .from('projects')
            .select('*')
            .eq('owner_id', user.id)
            .order('updated_at', { ascending: false });

        if (error) {
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        return NextResponse.json({ projects });
    } catch {
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}

// POST /api/projects — Create a new project
export async function POST(request: NextRequest) {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const body = await request.json();
        const { name, description = '' } = body;

        if (!name || typeof name !== 'string') {
            return NextResponse.json({ error: 'Name is required' }, { status: 400 });
        }

        // Create project
        const { data: project, error } = await supabase
            .from('projects')
            .insert({
                owner_id: user.id,
                name,
                description,
            })
            .select()
            .single();

        if (error) {
            console.error('[API] Project creation failed:', error.message);
            return NextResponse.json({ error: error.message }, { status: 500 });
        }

        // Create default project files (main scene + project config)
        const defaultFiles = [
            {
                project_id: project.id,
                path: 'axiom.project',
                content_type: 'text' as const,
                text_content: `[axiom]\nconfig_version=1\nproject/name="${name}"\nrun/main_scene="scenes/main.scene"\nrendering/renderer="gl_compatibility"`,
                size_bytes: 150,
            },
            {
                project_id: project.id,
                path: 'scenes/main.scene',
                content_type: 'text' as const,
                text_content: `[axiom_scene format=1]\n\n[node name="Main" type="Entity2D"]`,
                size_bytes: 60,
            },
            {
                project_id: project.id,
                path: 'scripts/main.axs',
                content_type: 'text' as const,
                text_content: `extends Entity2D\n\nfunc _ready():\n    print("Hello from Axiom!")\n\nfunc _process(delta):\n    pass`,
                size_bytes: 95,
            },
        ];

        await supabase.from('project_files').insert(defaultFiles);

        return NextResponse.json({ project }, { status: 201 });
    } catch (err) {
        console.error('[API] Project creation error:', err);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
