import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatMessage, LinkStatus } from "./useJarvis";
import type { VoiceStatus } from "./useVoice";

const VOICE_LABEL: Record<VoiceStatus, string> = {
  off: "Start voice conversation",
  connecting: "Cancel voice connection",
  live: "End voice conversation",
};

function MicButton({ status, disabled, onClick }: { status: VoiceStatus; disabled: boolean; onClick: () => void }) {
  const look =
    status === "live"
      ? "border-accent bg-accent text-ink shadow-[0_0_16px_rgb(var(--accent)/0.6)]"
      : status === "connecting"
        ? "animate-pulse border-accent/60 text-accent"
        : "border-white/15 text-dim hover:border-accent/60 hover:text-accent";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={VOICE_LABEL[status]}
      aria-pressed={status === "live"}
      title={VOICE_LABEL[status]}
      className={`flex h-10 w-10 shrink-0 items-center justify-center border transition-colors disabled:opacity-30 ${look}`}
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
      </svg>
    </button>
  );
}

const SUGGESTIONS = ["What can you do right now?", "Help me plan my day", "Explain something to me"];

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function Message({ msg, streaming }: { msg: ChatMessage; streaming: boolean }) {
  if (msg.role === "user") {
    return (
      <div className="ml-10 self-end border border-white/10 bg-white/5 px-3.5 py-2 text-[15px] leading-relaxed whitespace-pre-wrap">
        {msg.text}
      </div>
    );
  }
  if (msg.role === "tool") {
    return (
      <div className="flex items-center gap-2 font-mono text-xs text-accent/90">
        <span aria-hidden="true">▸</span>
        {msg.text}
      </div>
    );
  }
  if (msg.role === "error") {
    return (
      <div className="border-l-2 border-danger bg-danger/10 px-3.5 py-2 text-sm leading-relaxed text-danger" role="alert">
        {msg.text}
      </div>
    );
  }
  return (
    <div className="mr-6 border-l-2 border-accent/70 pl-3.5 text-[15px] leading-relaxed whitespace-pre-wrap transition-colors duration-500">
      {msg.text}
      {streaming && <span className="caret" />}
    </div>
  );
}

export function ChatPanel({
  messages,
  link,
  isStreaming,
  voice,
  onVoiceToggle,
  onSend,
  onReset,
  onTypingChange,
}: {
  messages: ChatMessage[];
  link: LinkStatus;
  isStreaming: boolean;
  voice: VoiceStatus;
  onVoiceToggle: () => void;
  onSend: (text: string) => void;
  onReset: () => void;
  onTypingChange: (typing: boolean) => void;
}) {
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const canSend = link === "online" && !isStreaming;

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  useEffect(() => {
    onTypingChange(draft.trim().length > 0);
  }, [draft, onTypingChange]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || !canSend) return;
    onSend(trimmed);
    setDraft("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit(draft);
    }
  };

  const lastId = messages[messages.length - 1]?.id;

  return (
    <section className="panel flex min-h-0 flex-col">
      <header className="flex items-center justify-between border-b border-white/5 px-5 py-3">
        <h2 className="label">Transcript</h2>
        <button
          type="button"
          onClick={onReset}
          disabled={messages.length === 0 || isStreaming}
          className="font-display text-xs font-semibold tracking-widest text-dim uppercase transition-colors hover:text-accent disabled:opacity-30 disabled:hover:text-dim"
        >
          Clear
        </button>
      </header>

      <div ref={listRef} className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {messages.length === 0 ? (
          <div className="m-auto flex max-w-xs flex-col items-center gap-4 text-center">
            <p className="font-display text-2xl font-semibold tracking-wide">{greeting()}.</p>
            <p className="text-sm text-dim">
              {link !== "online"
                ? "Waiting for the core to come online."
                : voice === "live"
                  ? "I'm listening. Go ahead."
                  : "All systems ready. Type, or press the microphone to talk."}
            </p>
            <div className="flex flex-col gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={!canSend}
                  onClick={() => submit(s)}
                  className="border border-accent/25 px-3 py-1.5 text-sm text-text transition-colors hover:border-accent/70 hover:bg-accent/10 disabled:opacity-40"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} msg={m} streaming={isStreaming && m.id === lastId} />)
        )}
      </div>

      <form onSubmit={onSubmit} className="flex items-end gap-2 border-t border-white/5 p-3">
        <MicButton status={voice} disabled={link !== "online"} onClick={onVoiceToggle} />
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          aria-label="Message Jarvis"
          placeholder={link === "online" ? "Talk to Jarvis…" : "Core offline"}
          className="max-h-32 min-h-10 flex-1 resize-none border border-white/10 bg-black/30 px-3 py-2 text-[15px] text-text outline-none placeholder:text-dim/70 focus:border-accent/60 [field-sizing:content]"
        />
        <button
          type="submit"
          disabled={!canSend || !draft.trim()}
          className="h-10 border border-accent/60 bg-accent/10 px-4 font-display text-sm font-bold tracking-widest text-accent uppercase transition-colors hover:bg-accent/25 disabled:border-white/10 disabled:bg-transparent disabled:text-dim/60"
        >
          Send
        </button>
      </form>
    </section>
  );
}
