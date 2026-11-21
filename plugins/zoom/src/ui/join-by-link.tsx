// Paste a Zoom link or a meeting number and join it.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseMeetingLink } from "../core/meeting-link.ts";

interface JoinByLinkProps {
  busy: boolean;
  onJoin: (link: string) => void;
}

export function JoinByLink({ busy, onJoin }: JoinByLinkProps) {
  const [link, setLink] = useState("");
  const [error, setError] = useState<string | null>(null);

  function submit() {
    try {
      parseMeetingLink(link);
    } catch (failure) {
      return setError(failure instanceof Error ? failure.message : "Неверная ссылка");
    }
    setError(null);
    onJoin(link);
  }

  return (
    <form
      className="relative flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input
        value={link}
        onChange={(event) => {
          setLink(event.target.value);
          setError(null);
        }}
        placeholder="Ссылка или номер встречи"
        aria-label="Ссылка или номер встречи"
        aria-invalid={error !== null}
        aria-describedby={error !== null ? "zoom-join-error" : undefined}
        className="h-8 w-56 max-w-full"
      />
      <Button type="submit" size="sm" variant="outline" disabled={busy || link.trim() === ""}>
        {busy ? "Вхожу…" : "Войти"}
      </Button>
      {error !== null && (
        <p id="zoom-join-error" role="alert" className="absolute left-0 top-full z-10 mt-1 rounded-md border border-border bg-popover px-2 py-1 text-xs text-destructive shadow-sm">
          {error}
        </p>
      )}
    </form>
  );
}
