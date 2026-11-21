import {
  ArrowRight,
  BarChart3,
  BellRing,
  Check,
  FileSearch,
  History,
  LifeBuoy,
  LockKeyhole,
  MessageSquareQuote,
  MessagesSquare,
  MousePointer2,
  PackageCheck,
  ScrollText,
  ShieldCheck,
  Store,
  UserCheck,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { ChannelTile, LanguageSwitch, Logo, LogoMark } from '../components/brand';
import { RobotBackdrop } from '../components/landing/RobotBackdrop';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';

/** Small section label: a number and a few words, set quietly above the headline. */
function Kicker({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`text-[13px] font-medium tracking-[0.01em] text-white/55 ${className}`}>{children}</p>;
}

function Cta({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="group inline-flex h-11 items-center gap-2 rounded-lg bg-white px-5 text-[15px] font-semibold text-black transition-colors hover:bg-white/85"
    >
      {children}
      <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}

function SectionLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <a
      href={href}
      aria-current={active ? 'true' : undefined}
      className={`inline-flex h-8 shrink-0 items-center rounded-lg px-2.5 text-[13px] whitespace-nowrap transition-colors ${
        active ? 'bg-white/15 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
      }`}
    >
      {label}
    </a>
  );
}

/** The section currently under the top third of the screen, for highlighting it in the top bar. */
function useActiveSection(hrefs: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  const key = hrefs.join(',');
  useEffect(() => {
    const ids = key.split(',');
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = window.innerHeight * 0.35;
      let current: string | null = null;
      for (const id of ids) {
        const el = document.querySelector(id);
        if (el && el.getBoundingClientRect().top <= line) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    // Anchor jumps glide, so the robot choreography plays along instead of cutting.
    const root = document.documentElement;
    root.style.scrollBehavior = 'smooth';
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
      root.style.scrollBehavior = '';
    };
  }, [key]);
  return active;
}

const S1_ICONS = [MessagesSquare, FileSearch, History];
const AGENT_ICONS = [Store, UserCheck, PackageCheck, BellRing];
const TRAINING_ICONS = [FileSearch, MessageSquareQuote, ScrollText];
const MORE_ICONS = [LifeBuoy, BarChart3, LockKeyhole];
/** Prices from the pitch deck (USD per month); features come from the Billing copy. */
const PRICING = [
  { id: 'free', price: 0 },
  { id: 'pro', price: 129 },
] as const;

export function LandingPage() {
  const { t } = useI18n();
  const { session } = useAuth();
  const l = t.landing;
  const primaryHref = session ? '/app' : '/signup';
  // The landing's sections, in page order, for the top bar.
  const sections = [
    { href: '#features', label: l.nav.features },
    { href: '#channels', label: l.nav.channels },
    { href: '#how', label: l.nav.how },
    { href: '#agent', label: l.nav.agent },
    { href: '#training', label: l.nav.training },
    { href: '#pricing', label: l.nav.pricing },
  ];
  const active = useActiveSection(sections.map((s) => s.href));
  const h2 = 'text-[clamp(2.2rem,4.6vw,4.75rem)] leading-[0.98] font-semibold tracking-[-0.035em] text-balance';
  const body = 'text-[clamp(1rem,1.1vw,1.15rem)] leading-relaxed text-white/70';

  return (
    <div className="relative min-h-dvh overflow-x-clip bg-[#06030d] text-white selection:bg-violet-500/40">
      <RobotBackdrop meetText={l.meetBig} />

      <header className="fixed inset-x-0 top-3 z-40 flex justify-center px-3">
        {/* One row: logo, the landing's sections, then language / sign in / get started. On
            narrow screens the sections scroll sideways inside the row. */}
        <nav className="flex w-full max-w-6xl items-center gap-2 rounded-2xl border border-white/10 bg-black/60 py-1.5 pr-1.5 pl-3 backdrop-blur-md" aria-label="Main">
          <span className="hidden shrink-0 sm:block">
            <Logo dark />
          </span>
          <Link to="/" className="shrink-0 sm:hidden" aria-label="GetCons">
            <LogoMark />
          </Link>
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [mask-image:linear-gradient(90deg,transparent,#000_12px,#000_calc(100%-12px),transparent)] px-2 [scrollbar-width:none] lg:justify-end lg:[mask-image:none] [&::-webkit-scrollbar]:hidden">
            {sections.map((s) => (
              <SectionLink key={s.href} {...s} active={active === s.href} />
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <LanguageSwitch compact dark />
            {!session && (
              <Link to="/login" className="hidden h-9 items-center rounded-lg px-3 text-sm text-white/80 hover:bg-white/10 md:inline-flex">
                {l.nav.signIn}
              </Link>
            )}
            <Link to={primaryHref} className="inline-flex h-9 items-center rounded-lg bg-white px-3.5 text-sm font-semibold text-black hover:bg-white/85">
              {session ? t.nav.overview : l.nav.start}
            </Link>
          </div>
        </nav>
      </header>

      {/* 1. The ceiling: while this tall section is pinned, scrolling only drives the assembly. */}
      <section data-robot="hero" className="relative z-10 h-[400vh]">
        <div className="sticky top-0 h-dvh overflow-hidden">
          {/* Under the wave, on both sides: the headline on the left, the text and the action on
              the right, both resting on the same baseline. */}
          <div
            className="gc-hero-layer absolute inset-x-0 bottom-0 px-5 pb-14 sm:px-8 md:pb-20 lg:px-12"
            style={{ opacity: 'max(0, calc(1 - var(--gc-hero, 0) * 2.6))' }}
          >
            <div className="mx-auto grid max-w-7xl items-end gap-8 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] md:gap-12 lg:gap-20">
              <div>
                <Kicker>{l.heroKicker}</Kicker>
                <h1 className="mt-5 text-[clamp(2.2rem,4vw,4.25rem)] leading-[1.06] font-semibold tracking-[-0.028em] text-balance">
                  <span className="block">
                    {l.hero1} {l.hero2}
                  </span>
                  <span className="text-gradient block">{l.hero3}</span>
                </h1>
              </div>
              <div className="max-w-md md:justify-self-end">
                <p className="text-[clamp(1rem,1.15vw,1.15rem)] leading-relaxed text-white/70">{l.heroCaption}</p>
                <div className="mt-6">
                  <Cta to={primaryHref}>{l.ctaPrimary}</Cta>
                </div>
                <p className="mt-4 text-[13px] text-white/45">{l.noCard}</p>
              </div>
            </div>
            {/* Below the headline (the layer's bottom padding keeps them apart). */}
            <p className="absolute inset-x-0 bottom-3 hidden text-center text-[12px] text-white/50 md:block">
              {l.scroll}
              <span className="mx-auto mt-1.5 block h-5 w-px bg-white/30" />
            </p>
          </div>

          {/* The assembled robot: introduce it. */}
          <div
            className="gc-meet-layer absolute inset-x-0 bottom-0 flex flex-col gap-6 bg-gradient-to-t from-[#06030d]/85 via-[#06030d]/40 to-transparent px-5 pt-28 pb-8 sm:px-8 md:flex-row md:items-end md:justify-between lg:px-12 lg:pb-12"
            style={{ opacity: 'max(0, calc((var(--gc-meet, 0) - 0.55) * 2.2))' }}
          >
            <div className="max-w-[26rem] space-y-3">
              <Kicker>{l.meetKicker}</Kicker>
              <p className="text-[clamp(1.05rem,1.35vw,1.4rem)] leading-snug text-white/85">{l.meetText}</p>
            </div>
            <div className="space-y-3 md:text-right">
              <p className="flex items-center gap-2 text-[13px] text-white/55 md:justify-end [@media(hover:none)]:hidden">
                <MousePointer2 className="size-3.5" aria-hidden /> {l.meetHint}
              </p>
              <div className="md:flex md:justify-end">
                <Cta to={primaryHref}>{l.ctaPrimary}</Cta>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 2. Robot close on the right, text on the left. */}
      <section data-robot="right" id="features" className="relative z-10 flex min-h-[140vh] scroll-mt-20 items-center px-5 py-24 sm:px-8 lg:px-12">
        <div className="mx-auto grid w-full max-w-7xl md:grid-cols-2">
          <div className="max-w-xl md:pr-10 lg:pr-16">
            <Kicker>{l.s1Kicker}</Kicker>
            <h2 className={`mt-5 ${h2}`}>{l.s1Title}</h2>
            <p className={`mt-6 ${body}`}>{l.s1Text}</p>
            <div className="mt-10 grid gap-3">
              {l.s1Cards.map((c, i) => {
                const Icon = S1_ICONS[i] ?? MessagesSquare;
                return (
                  <div key={c.title} className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.04] p-5 backdrop-blur-md">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.07] text-white/80">
                      <Icon className="size-[18px]" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="text-[17px] font-semibold">{c.title}</h3>
                      <p className="mt-1.5 text-[15px] leading-relaxed text-white/65">{c.text}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* 3. Robot recedes; one-click message and numbers. */}
      <section data-robot="center" id="channels" className="relative z-10 flex min-h-[125vh] scroll-mt-20 flex-col items-center px-5 pt-[14vh] text-center sm:px-8">
        <Kicker>{l.s2Kicker}</Kicker>
        <h2 className={`mt-5 max-w-4xl ${h2}`}>{l.s2Title}</h2>
        <p className={`mt-5 max-w-xl ${body}`}>{l.s2Text}</p>
        {/* Where customers write: WhatsApp, Telegram, the website. */}
        <div className="mt-10 grid w-full max-w-5xl gap-3 text-left md:grid-cols-3">
          {l.channels.map((ch) => (
            <div key={ch.name} className="flex gap-4 rounded-xl border border-white/10 bg-white/[0.05] p-5 backdrop-blur-md">
              <ChannelTile channel={ch.id} className="size-11" />
              <div className="min-w-0">
                <h3 className="text-[17px] font-semibold">{ch.name}</h3>
                <p className="mt-1 text-[14px] leading-relaxed text-white/65">{ch.text}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-6 grid w-full max-w-5xl grid-cols-2 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 lg:grid-cols-4">
          {l.stats.map((s) => (
            <div key={s.value} className="bg-[#06030d]/75 px-4 py-6 backdrop-blur-md">
              <p className="text-[clamp(1.3rem,2vw,1.9rem)] font-semibold tracking-tight">{s.value}</p>
              <p className="mt-1 text-[13px] text-white/55">{s.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 4. Robot close on the left, steps on the right. */}
      <section data-robot="left" id="how" className="relative z-10 flex min-h-[140vh] scroll-mt-20 items-center px-5 py-24 sm:px-8 lg:px-12">
        <div className="mx-auto grid w-full max-w-7xl md:grid-cols-2">
          <div className="md:col-start-2 md:pl-10 lg:pl-16">
            <Kicker>{l.s3Kicker}</Kicker>
            <h2 className={`mt-5 ${h2}`}>{l.s3Title}</h2>
            <ol className="mt-10 border-t border-white/15">
              {l.steps.map((s, i) => (
                <li key={s.title} className="grid grid-cols-[4.5rem_1fr] gap-4 border-b border-white/15 py-6">
                  <span className="pt-1 text-[15px] font-medium text-white/40 tabular-nums">0{i + 1}</span>
                  <div>
                    <h3 className="text-[clamp(1.2rem,1.6vw,1.5rem)] font-semibold tracking-tight">{s.title}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-white/65">{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-8">
              <Cta to={primaryHref}>{l.ctaPrimary}</Cta>
            </div>
          </div>
        </div>
      </section>

      {/* 5. The robot dissolves: its particles drift behind the rest of the page. */}
      <div data-robot="dust" className="relative z-10">
        {/* The robot is gone: from here on the copy sits in the middle of the page. */}
        <section id="agent" className="scroll-mt-20 px-5 pt-[30vh] pb-24 sm:px-8 lg:px-12">
          <div className="mx-auto grid max-w-7xl items-start gap-12 lg:grid-cols-[1fr_minmax(0,26rem)] lg:gap-16">
            <div>
              <Kicker>{l.agentKicker}</Kicker>
              <h2 className={`mt-5 max-w-3xl ${h2}`}>{l.agentTitle}</h2>
              <p className={`mt-6 max-w-2xl ${body}`}>{l.agentText}</p>
              <div className="mt-10 grid gap-3 sm:grid-cols-2">
                {l.agentPoints.map((pt, i) => {
                  const Icon = AGENT_ICONS[i] ?? Store;
                  return (
                    <div key={pt.title} className="rounded-xl border border-white/10 bg-[#06030d]/70 p-5 backdrop-blur-md">
                      <Icon className="size-5 text-white/80" aria-hidden />
                      <h3 className="mt-4 text-[17px] font-semibold">{pt.title}</h3>
                      <p className="mt-1.5 text-[15px] leading-relaxed text-white/65">{pt.text}</p>
                    </div>
                  );
                })}
              </div>
              <p className="mt-6 inline-block rounded-lg bg-[#06030d]/75 px-3 py-2 text-[14px] text-white/60 backdrop-blur-sm">{l.agentPlans}</p>
            </div>
            {/* What it looks like for the customer: an order placed and paid inside the chat. */}
            <div className="rounded-2xl border border-white/10 bg-[#0d0b12]/90 p-4 backdrop-blur-md" aria-label={l.agentChatLabel}>
              <div className="flex items-center gap-2.5 border-b border-white/10 px-1 pb-3">
                <ChannelTile channel="whatsapp" className="size-8 rounded-lg" />
                <div>
                  <p className="text-sm font-semibold">{l.agentChatName}</p>
                  <p className="text-xs text-white/45">{l.agentChatStatus}</p>
                </div>
              </div>
              <div className="space-y-2 pt-3 text-[14px] leading-snug">
                {l.agentChat.map((m, i) => (
                  <p
                    key={i}
                    className={`max-w-[85%] rounded-xl px-3 py-2 whitespace-pre-line ${
                      m.from === 'customer' ? 'ml-auto rounded-br-sm bg-white text-black' : 'rounded-bl-sm bg-white/[0.08] text-white/85'
                    }`}
                  >
                    {m.text}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section id="training" className="scroll-mt-20 px-5 py-24 text-center sm:px-8 lg:px-12">
          <div className="mx-auto max-w-7xl">
            <Kicker>{l.trainingKicker}</Kicker>
            <h2 className={`mx-auto mt-5 max-w-3xl ${h2}`}>{l.trainingTitle}</h2>
            <p className={`mx-auto mt-6 max-w-3xl ${body}`}>{l.trainingText}</p>
            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 md:grid-cols-3">
              {l.trainingPoints.map((p, i) => {
                const Icon = TRAINING_ICONS[i] ?? FileSearch;
                return (
                  <div key={p.title} className="flex flex-col items-center bg-[#06030d]/70 p-7 backdrop-blur-md">
                    <Icon className="size-6 text-white/80" aria-hidden />
                    <h3 className="mt-5 text-lg font-semibold">{p.title}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-white/65">{p.text}</p>
                  </div>
                );
              })}
            </div>
            <p className="mx-auto mt-8 max-w-3xl rounded-xl bg-[#06030d]/70 px-4 py-3 text-sm leading-relaxed text-white/70 backdrop-blur-sm">{l.trainingNote}</p>
          </div>
        </section>

        <section className="px-5 py-24 text-center sm:px-8 lg:px-12">
          <div className="mx-auto max-w-7xl">
            <Kicker>{l.moreKicker}</Kicker>
            <h2 className={`mx-auto mt-5 max-w-3xl ${h2}`}>{l.moreTitle}</h2>
            <div className="mt-12 grid gap-4 md:grid-cols-3">
              {l.more.map((m, i) => {
                const Icon = MORE_ICONS[i] ?? ShieldCheck;
                return (
                  <div key={m.title} className="flex flex-col items-center rounded-xl border border-white/10 bg-[#06030d]/60 p-7 backdrop-blur-md">
                    <Icon className="size-6 text-white/80" aria-hidden />
                    <h3 className="mt-5 text-lg font-semibold">{m.title}</h3>
                    <p className="mt-2 text-[15px] leading-relaxed text-white/60">{m.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section id="pricing" className="scroll-mt-20 px-5 py-24 text-center sm:px-8 lg:px-12">
          <div className="mx-auto max-w-7xl">
            <Kicker>{l.pricingKicker}</Kicker>
            <h2 className={`mx-auto mt-5 max-w-3xl ${h2}`}>{l.pricingTitle}</h2>
            <p className={`mx-auto mt-6 max-w-2xl ${body}`}>{l.pricingText}</p>
            <div className="mt-12 grid gap-4 text-left mx-auto max-w-4xl sm:grid-cols-2">
              {PRICING.map(({ id, price }) => {
                const plan = t.billing.plans[id];
                const agent = id === 'pro';
                return (
                  <div key={id} className={`flex flex-col rounded-xl border bg-[#06030d]/70 p-6 backdrop-blur-md ${agent ? 'border-white/45' : 'border-white/10'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-lg font-semibold">{plan.name}</h3>
                      {agent && <span className="rounded-md bg-white px-2 py-0.5 text-[11px] font-semibold text-black">{l.agentBadge}</span>}
                    </div>
                    <p className="mt-4 text-4xl font-semibold tracking-tight">
                      ${price}
                      <span className="text-base font-normal text-white/50">{t.billing.perMonth}</span>
                    </p>
                    <ul className="mt-5 flex-1 space-y-2.5 text-[14px] text-white/70">
                      {plan.features.map((f) => (
                        <li key={f} className="flex gap-2">
                          <Check className="mt-0.5 size-4 shrink-0 text-white/60" aria-hidden />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            <div className="mt-10 flex justify-center">
              <Cta to={primaryHref}>{l.pricingCta}</Cta>
            </div>
          </div>
        </section>
      </div>

      {/* 6. The last screen: the particles gather into the "GetCons" wordmark above the call to action. */}
      <section data-robot="text" className="relative z-10 flex h-dvh min-h-[34rem] flex-col justify-end px-5 sm:px-8 lg:px-12">
        <h2 className="sr-only">GetCons</h2>
        <div className="mx-auto w-full max-w-3xl pb-[6vh] text-center">
          <p className="text-[clamp(1.6rem,3.2vw,3.2rem)] leading-[1.05] font-semibold tracking-[-0.03em] text-balance">{l.ctaTitle}</p>
          <p className="mx-auto mt-4 max-w-xl text-[clamp(1rem,1.1vw,1.15rem)] text-white/75">{l.ctaText}</p>
          <div className="mt-8 flex justify-center">
            <Cta to={primaryHref}>{l.ctaPrimary}</Cta>
          </div>
          <p className="mt-4 text-[13px] text-white/45">{l.noCard}</p>
        </div>
        <footer className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-4 border-t border-white/10 py-6 text-sm text-white/50">
          <Logo dark />
          <p>{l.footer}</p>
        </footer>
      </section>
    </div>
  );
}
