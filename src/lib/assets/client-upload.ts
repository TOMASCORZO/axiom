import { createClient } from '@/lib/supabase/client';

export interface UploadedImage {
    storageKey: string;
    targetPath: string;
    width: number;
    height: number;
    sizeBytes: number;
    sourceUrl: string;
    fileFormat: string;
}

export async function uploadImageFile(file: File, projectId: string): Promise<UploadedImage> {
    if (!file.type.startsWith('image/')) {
        throw new Error('File must be an image');
    }

    const rawExt = file.name.split('.').pop()?.toLowerCase() ?? 'png';
    const ext = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(rawExt) ? rawExt : 'png';
    const baseName = file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30) || 'upload';
    const targetPath = `assets/uploads/${baseName}_${Date.now() % 1_000_000}.${ext}`;

    const urlRes = await fetch('/api/assets/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_id: projectId, target_path: targetPath }),
    });
    if (!urlRes.ok) {
        const data = await urlRes.json().catch(() => ({}));
        throw new Error(data.error || `Upload URL request failed: ${urlRes.status}`);
    }
    const { token, storage_key: storageKey } = await urlRes.json() as { token: string; storage_key: string };

    const supabase = createClient();
    const { error: uploadErr } = await supabase.storage
        .from('assets')
        .uploadToSignedUrl(storageKey, token, file, { contentType: file.type, upsert: true });
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);

    await fetch('/api/assets/register-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            project_id: projectId,
            target_path: targetPath,
            storage_key: storageKey,
            size_bytes: file.size,
        }),
    });

    const { width, height } = await readImageDimensions(file);
    const sourceUrl = `${window.location.origin}/api/assets/serve?key=${encodeURIComponent(storageKey)}`;

    return { storageKey, targetPath, width, height, sizeBytes: file.size, sourceUrl, fileFormat: ext };
}

function readImageDimensions(file: File): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const dims = { width: img.naturalWidth, height: img.naturalHeight };
            URL.revokeObjectURL(url);
            resolve(dims);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Could not read image dimensions'));
        };
        img.src = url;
    });
}
