/**
 * Lightweight SQL editor with syntax highlighting.
 *
 * Implementation: a transparent <textarea> stacked on top of a colorized
 * <pre>. Both share font, padding, and wrapping rules so the cursor lines up
 * with the colored text behind it. No external editor library — keeps the
 * bundle small and avoids loading Monaco for what's a 5-line input.
 *
 * The tokenizer is intentionally simple (regex-based, no AST) — pgsql-ast-parser
 * runs server-side for actual validation; this is purely cosmetic.
 */

import { useRef } from 'react';

const TOKEN_RE = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('([^']|'')*')|(\b\d+(\.\d+)?\b)|([a-zA-Z_][a-zA-Z0-9_]*)|(\s+)|([^\s\w])/g;

const KEYWORDS = new Set([
    'select','from','where','and','or','not','in','is','null','true','false',
    'insert','into','values','update','set','delete','returning',
    'create','table','alter','drop','add','column','if','exists','rename','to','index','sequence','schema','type',
    'primary','key','foreign','references','unique','check','constraint','default',
    'on','cascade','restrict','no','action',
    'order','by','asc','desc','limit','offset','group','having','distinct','as',
    'join','inner','left','right','outer','full','cross','using',
    'union','intersect','except','all','with','recursive',
    'case','when','then','else','end',
    'begin','commit','rollback','transaction',
    'truncate','grant','revoke',
    'enum','replace',
]);

const TYPES = new Set([
    'int','int2','int4','int8','integer','smallint','bigint','serial','bigserial',
    'numeric','decimal','real','double','precision','float','money',
    'text','varchar','char','character','citext',
    'bool','boolean',
    'date','time','timestamp','timestamptz','interval',
    'uuid','json','jsonb','bytea','xml','inet','cidr','macaddr',
    'array',
]);

interface Token {
    text: string;
    kind: 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'identifier' | 'operator' | 'whitespace';
}

function tokenize(sql: string): Token[] {
    const tokens: Token[] = [];
    let lastIndex = 0;
    TOKEN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TOKEN_RE.exec(sql)) !== null) {
        if (match.index > lastIndex) {
            tokens.push({ text: sql.slice(lastIndex, match.index), kind: 'identifier' });
        }
        const [whole, comment, str, , number, , word, ws, op] = match;
        if (comment !== undefined) tokens.push({ text: whole, kind: 'comment' });
        else if (str !== undefined) tokens.push({ text: whole, kind: 'string' });
        else if (number !== undefined) tokens.push({ text: whole, kind: 'number' });
        else if (word !== undefined) {
            const lower = word.toLowerCase();
            const kind: Token['kind'] = KEYWORDS.has(lower) ? 'keyword'
                : TYPES.has(lower) ? 'type'
                : 'identifier';
            tokens.push({ text: whole, kind });
        }
        else if (ws !== undefined) tokens.push({ text: whole, kind: 'whitespace' });
        else if (op !== undefined) tokens.push({ text: whole, kind: 'operator' });
        lastIndex = match.index + whole.length;
    }
    if (lastIndex < sql.length) tokens.push({ text: sql.slice(lastIndex), kind: 'identifier' });
    return tokens;
}

const COLORS: Record<Token['kind'], string> = {
    keyword: 'text-cyan-400',
    type: 'text-amber-300',
    string: 'text-emerald-400',
    number: 'text-fuchsia-400',
    comment: 'text-zinc-600 italic',
    identifier: 'text-zinc-200',
    operator: 'text-zinc-400',
    whitespace: '',
};

interface SqlEditorProps {
    value: string;
    onChange: (value: string) => void;
    onRun?: () => void;
    rows?: number;
    placeholder?: string;
}

export function SqlEditor({ value, onChange, onRun, rows = 6, placeholder }: SqlEditorProps) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    const preRef = useRef<HTMLPreElement>(null);

    const syncScroll = () => {
        if (taRef.current && preRef.current) {
            preRef.current.scrollTop = taRef.current.scrollTop;
            preRef.current.scrollLeft = taRef.current.scrollLeft;
        }
    };

    const tokens = tokenize(value);

    // Container owns the border/bg/focus ring. Pre is absolute behind the
    // textarea, painting the colors. Textarea sits on top with transparent
    // text and bg — only its caret, selection, and scroll behaviors stay.
    return (
        <div className="relative w-full bg-zinc-900 border border-white/10 rounded-lg focus-within:border-cyan-500/50 transition-colors">
            <pre
                ref={preRef}
                aria-hidden="true"
                className="absolute inset-0 m-0 px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words overflow-auto pointer-events-none"
            >
                {tokens.map((t, i) => (
                    <span key={i} className={COLORS[t.kind]}>{t.text}</span>
                ))}
                {/* Zero-width space so the trailing newline still allocates a line. */}
                {value.endsWith('\n') && '\u200b'}
            </pre>
            <textarea
                ref={taRef}
                value={value}
                onChange={e => onChange(e.target.value)}
                onScroll={syncScroll}
                onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                        e.preventDefault();
                        onRun?.();
                    }
                }}
                rows={rows}
                placeholder={placeholder}
                spellCheck={false}
                className="relative block w-full bg-transparent border-0 px-3 py-2 text-xs font-mono resize-none focus:outline-none caret-zinc-200 selection:bg-cyan-500/30"
                style={{
                    color: 'transparent',
                    WebkitTextFillColor: 'transparent',
                }}
            />
        </div>
    );
}
