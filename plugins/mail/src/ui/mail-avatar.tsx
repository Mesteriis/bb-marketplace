/** Decorative initials beside a sender whose full name is available in the same row. */
export function MailAvatar({ name }: { name: string }) {
  const initials = name.trim().split(/[\s,@]+/u).slice(0, 2).map((part) => Array.from(part)[0]).join("").toLocaleUpperCase();
  return (
    <span aria-hidden className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary">
      {initials}
    </span>
  );
}
