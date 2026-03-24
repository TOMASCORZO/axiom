import { type NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

export async function middleware(request: NextRequest) {
    try {
        return await updateSession(request);
    } catch {
        // If middleware fails (e.g. missing env vars), let the request through
        return NextResponse.next({ request });
    }
}

export const config = {
    matcher: [
        '/((?!_next/static|_next/image|favicon.ico|engine/|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|wasm|js)$).*)',
    ],
};
