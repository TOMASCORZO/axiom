import { type NextRequest, NextResponse } from 'next/server';
import { updateSession } from '@/lib/supabase/middleware';

function applyIsolationHeaders(res: NextResponse, pathname: string): NextResponse {
    if (pathname.startsWith('/engine')) {
        res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        res.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
        res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    } else if (pathname.startsWith('/editor')) {
        res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        res.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
    }
    return res;
}

export async function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    if (pathname.startsWith('/engine')) {
        return applyIsolationHeaders(NextResponse.next({ request }), pathname);
    }

    try {
        const res = await updateSession(request);
        return applyIsolationHeaders(res, pathname);
    } catch {
        return applyIsolationHeaders(NextResponse.next({ request }), pathname);
    }
}

export const config = {
    matcher: [
        '/engine/:path*',
        '/((?!_next/static|_next/image|favicon.ico|api/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
};
