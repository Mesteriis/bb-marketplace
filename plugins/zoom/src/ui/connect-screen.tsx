// Shown until a Zoom account is connected: what to set up in Zoom, the
// redirect URL to register there, and the button that starts the sign-in.
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { messageOf, type ZoomPageApi } from "./api.ts";

const SCOPES = [
  "meeting:read:list_meetings",
  "meeting:write:meeting",
  "user:read:user",
  "user:read:token",
] as const;

interface ConnectScreenProps {
  api: ZoomPageApi;
  origin: string;
  configured: boolean;
  onConnect: () => void;
  onRecheck: () => void;
  connecting: boolean;
}

export function ConnectScreen({ api, origin, configured, onConnect, onRecheck, connecting }: ConnectScreenProps) {
  const [redirect, setRedirect] = useState<{ uri: string | null; error: string | null }>({ uri: null, error: null });

  useEffect(() => {
    let cancelled = false;
    api.redirectUri(origin).then(
      (uri) => !cancelled && setRedirect({ uri, error: null }),
      (error: unknown) => !cancelled && setRedirect({ uri: null, error: messageOf(error) }),
    );
    return () => {
      cancelled = true;
    };
  }, [api, origin]);

  // Zoom takes a loopback address only from a PKCE public client, in its own field.
  const loopback = redirect.uri?.startsWith("http://127.0.0.1") ?? false;

  return (
    <div className="mx-auto flex h-full max-w-xl flex-col justify-center gap-5 overflow-auto p-6">
      <div>
        <h1 className="text-base font-semibold">Подключите аккаунт Zoom</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Плагин работает через ваше собственное приложение Zoom. Его нужно создать один раз.
        </p>
      </div>
      <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm">
        <li>
          В Zoom App Marketplace создайте <span className="font-medium">General app</span>, управляемое пользователем
          (User-managed), и включите в нём Meeting SDK.
        </li>
        <li>
          {loopback
            ? "В Basic information включите Use public client OAuth и вставьте этот адрес в поле PKCE OAuth Redirect URL:"
            : "Вставьте этот адрес в OAuth Redirect URL и в OAuth Allow List:"}
          {redirect.uri !== null && (
            <code className="mt-1 block select-all break-all rounded-md border border-border bg-secondary px-2 py-1.5 text-xs">
              {redirect.uri}
            </code>
          )}
          {redirect.error !== null && (
            <span role="alert" className="mt-1 block text-destructive">
              {redirect.error}
            </span>
          )}
        </li>
        <li>
          Добавьте области доступа:
          <span className="mt-1 flex flex-wrap gap-1">
            {SCOPES.map((scope) => (
              <code key={scope} className="rounded border border-border bg-secondary px-1.5 py-0.5 text-xs">
                {scope}
              </code>
            ))}
          </span>
        </li>
        <li>
          Вставьте Client ID и Client Secret{loopback ? ", а также Public client ID" : ""} в настройки плагина Makosh Zoom.
          {!configured && <span className="mt-1 block text-muted-foreground">Сейчас они не заданы.</span>}
        </li>
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onConnect} disabled={!configured || connecting || redirect.uri === null}>
          {connecting ? "Открываю Zoom…" : "Войти через Zoom"}
        </Button>
        <Button variant="ghost" onClick={onRecheck}>
          Проверить снова
        </Button>
      </div>
    </div>
  );
}
