import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Turbopack config (Next.js 16 uses Turbopack by default)
  turbopack: {},

  // Ensure native binaries are bundled into serverless functions
  serverExternalPackages: ['ffmpeg-static', 'sharp'],
  outputFileTracingIncludes: {
    '/api/assets/generate': ['./node_modules/ffmpeg-static/**/*'],
  },

  // Headers for engine WASM files
  // SharedArrayBuffer requires Cross-Origin-Opener-Policy + Cross-Origin-Embedder-Policy
  async headers() {
    return [
      {
        // Editor pages need cross-origin isolation for SharedArrayBuffer
        // (required by Godot 4 WASM engine running in iframe)
        // Using 'credentialless' instead of 'require-corp' so external
        // resources (fonts, images, CDN scripts) don't break
        source: '/editor/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless',
          },
        ],
      },
      {
        source: '/engine/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'require-corp',
          },
          {
            key: 'Cross-Origin-Resource-Policy',
            value: 'same-origin',
          },
        ],
      },
      {
        source: '/engine/:path*.wasm',
        headers: [
          {
            key: 'Content-Type',
            value: 'application/wasm',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
