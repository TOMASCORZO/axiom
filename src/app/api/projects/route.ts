import { NextRequest, NextResponse } from 'next/server';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getAdminClient } from '@/lib/supabase/admin';

// GET /api/projects — List user's projects
export async function GET() {
    try {
        const supabase = await createServerSupabaseClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const admin = getAdminClient();
        const { data: projects, error } = await admin
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

        const admin = getAdminClient();

        // Create project
        const { data: project, error } = await admin
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
                path: 'project.axiom',
                content_type: 'text' as const,
                text_content: `; Axiom Engine Project Configuration\n[application]\nconfig/name="${name}"\nrun/main_scene="res://scenes/main.scene"\nconfig/features=PackedStringArray("2D")\n\n[display]\nwindow/size/viewport_width=1280\nwindow/size/viewport_height=720\nwindow/stretch/mode="canvas_items"\n\n[physics]\n2d/default_gravity=980.0\n\n[rendering]\nrenderer/rendering_method="gl_compatibility"\n`,
                size_bytes: 350,
            },
            {
                project_id: project.id,
                path: 'scenes/main.scene',
                content_type: 'text' as const,
                text_content: `[axiom_scene format=3]\n\n[node name="Main" type="Entity2D"]\nscript = ExtResource("scripts/main.axs")\n`,
                size_bytes: 90,
            },
            {
                project_id: project.id,
                path: 'scripts/main.axs',
                content_type: 'text' as const,
                text_content: `extends Entity2D\n\nfunc _ready():\n    print("Hello from Axiom!")\n\nfunc _process(delta):\n    pass\n`,
                size_bytes: 95,
            },
        ];

        await admin.from('project_files').insert(defaultFiles);

        return NextResponse.json({ project }, { status: 201 });
    } catch (err) {
        console.error('[API] Project creation error:', err);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
