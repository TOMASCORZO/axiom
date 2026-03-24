import Link from 'next/link';
import {
  Gamepad2,
  Sparkles,
  Layers,
  Zap,
  ArrowRight,
  Github,
  Box,
  Palette,
  Code2,
} from 'lucide-react';

export default function HomePage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      {/* Navbar */}
      <nav className="fixed top-0 left-0 right-0 z-50 border-b border-white/5 bg-zinc-950/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
              <span className="text-white text-sm font-black">A</span>
            </div>
            <span className="text-lg font-bold bg-gradient-to-r from-violet-300 to-fuchsia-300 bg-clip-text text-transparent">
              Axiom
            </span>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-sm text-zinc-400 hover:text-white transition-colors">
              Sign In
            </Link>
            <Link
              href="/register"
              className="text-sm px-4 py-2 bg-violet-600 hover:bg-violet-500 rounded-lg font-medium transition-colors"
            >
              Get Started
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative pt-40 pb-24 px-6 overflow-hidden">
        {/* Background glow */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-violet-500/10 blur-[120px] rounded-full" />
        <div className="absolute top-20 right-1/4 w-[400px] h-[400px] bg-fuchsia-500/8 blur-[100px] rounded-full" />

        <div className="relative max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-violet-500/10 border border-violet-500/20 rounded-full text-sm text-violet-300 mb-8">
            <Sparkles size={14} />
            AI-Powered Game Engine
          </div>

          <h1 className="text-5xl md:text-7xl font-bold tracking-tight mb-6 leading-[1.1]">
            Build games with
            <br />
            <span className="bg-gradient-to-r from-violet-400 via-fuchsia-400 to-pink-400 bg-clip-text text-transparent">
              AI intelligence
            </span>
          </h1>

          <p className="text-lg md:text-xl text-zinc-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            A browser-based game engine where an AI agent generates assets,
            writes logic, builds scenes, and runs your game — all from a
            conversation.
          </p>

          <div className="flex items-center justify-center gap-4">
            <Link
              href="/register"
              className="group flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 rounded-xl text-sm font-semibold transition-all shadow-lg shadow-violet-500/20"
            >
              Start Creating
              <ArrowRight size={16} className="group-hover:translate-x-0.5 transition-transform" />
            </Link>
            <Link
              href="#features"
              className="flex items-center gap-2 px-6 py-3 bg-white/5 hover:bg-white/10 border border-white/10 rounded-xl text-sm font-medium transition-colors"
            >
              <Github size={16} />
              Learn More
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="py-24 px-6">
        <div className="max-w-6xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-3xl md:text-4xl font-bold mb-4">
              Everything you need to build games
            </h2>
            <p className="text-zinc-400 max-w-xl mx-auto">
              From pixel art to 3D worlds, Axiom&apos;s AI agent handles it all.
            </p>
          </div>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                icon: Sparkles,
                title: 'AI Agent',
                description: 'Describe what you want — the agent creates scenes, writes scripts, and generates assets autonomously.',
                color: 'violet',
              },
              {
                icon: Gamepad2,
                title: 'Live Preview',
                description: 'See your game running in real-time inside the browser. Every change is instantly reflected.',
                color: 'emerald',
              },
              {
                icon: Palette,
                title: 'Asset Generation',
                description: 'Generate sprites, textures, 3D models, and animations from text prompts. Any style: pixel art, realistic, stylized.',
                color: 'sky',
              },
              {
                icon: Code2,
                title: 'AxiomScript',
                description: 'A powerful scripting language for game logic. The AI writes it, you customize it.',
                color: 'amber',
              },
              {
                icon: Box,
                title: '2D & 3D',
                description: 'Build any type of game — platformers, RPGs, shooters, puzzle games, 3D adventures, and more.',
                color: 'rose',
              },
              {
                icon: Layers,
                title: 'Scene Builder',
                description: 'Visual scene graph editor with drag-and-drop. Layer entities, configure physics, animate everything.',
                color: 'teal',
              },
            ].map((feature) => (
              <div
                key={feature.title}
                className="group p-6 bg-zinc-900/50 border border-white/5 rounded-2xl hover:border-white/10 transition-all hover:shadow-lg hover:shadow-violet-500/5"
              >
                <div className={`w-10 h-10 rounded-xl bg-${feature.color}-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform`}>
                  <feature.icon size={20} className={`text-${feature.color}-400`} />
                </div>
                <h3 className="text-lg font-semibold mb-2">{feature.title}</h3>
                <p className="text-sm text-zinc-400 leading-relaxed">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="p-12 bg-gradient-to-br from-violet-500/10 via-fuchsia-500/5 to-transparent border border-violet-500/20 rounded-3xl">
            <Zap size={32} className="text-violet-400 mx-auto mb-4" />
            <h2 className="text-3xl font-bold mb-3">Ready to build your game?</h2>
            <p className="text-zinc-400 mb-8">
              Start with a prompt. The AI builds your entire game.
            </p>
            <Link
              href="/register"
              className="inline-flex items-center gap-2 px-8 py-3.5 bg-gradient-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 rounded-xl font-semibold transition-all shadow-lg shadow-violet-500/25"
            >
              Get Started Free
              <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-white/5 py-8 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center">
              <span className="text-white text-xs font-black">A</span>
            </div>
            <span className="text-sm text-zinc-500">Axiom Engine © 2026</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-zinc-500">
            <a href="#" className="hover:text-zinc-300 transition-colors">Docs</a>
            <a href="#" className="hover:text-zinc-300 transition-colors">Pricing</a>
            <a href="#" className="hover:text-zinc-300 transition-colors">Community</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
