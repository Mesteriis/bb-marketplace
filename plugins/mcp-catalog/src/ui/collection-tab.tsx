import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { CollectionItem, ReviewItem } from "../core/contract";
import { messageOf, type CatalogApi, type Notify, type Setup } from "./api";
import { VariablesDialog } from "./install-dialog";
import { Badge, Centered, LoadView, Notice, Row } from "./parts";
import { useLoad } from "./use-load";

const REVIEW_LABEL: Record<ReviewItem["state"], string> = {
  reviewing: "идёт проверка",
  ready: "проверка готова",
  failed: "проверка не удалась",
  accepted: "принято",
  rejected: "отклонено",
};

const POLL_MS = 15_000;

interface Props {
  api: CatalogApi;
  notify: Notify;
  tick: number;
  onChanged: () => void;
  setup: Setup;
}

export function CollectionTab({ api, notify, tick, onChanged, setup }: Props) {
  const collection = useLoad(() => api.collection(), tick);
  const reviews = useLoad(() => api.reviews(), tick);
  const [installing, setInstalling] = useState<CollectionItem | null>(null);

  const open = reviews.state.kind === "ready" && reviews.state.data.items.some((item) => item.state === "reviewing");
  const reloadReviews = reviews.reload;
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(reloadReviews, POLL_MS);
    return () => clearInterval(timer);
  }, [open, reloadReviews]);

  const loadVariables = useCallback(
    () => (installing === null ? Promise.reject(new Error("не выбран сервер")) : api.secretsState({ name: installing.name })),
    [api, installing],
  );

  return (
    <div className="flex flex-col">
      <LoadView state={reviews.state} onRetry={reviews.reload}>
        {({ items }) =>
          items.length === 0 ? null : (
            <section aria-label="Проверки">
              <h2 className="px-4 pt-3 text-xs font-medium uppercase text-muted-foreground">Проверки</h2>
              <ul>
                {items.map((item) => (
                  <ReviewRow key={item.name} item={item} api={api} notify={notify} onChanged={onChanged} canDecide={setup.repo} />
                ))}
              </ul>
            </section>
          )
        }
      </LoadView>
      <LoadView state={collection.state} onRetry={collection.reload}>
        {({ items }) =>
          items.length === 0 ? (
            <Centered>
              <p>В коллекции пока ничего нет</p>
              <p className="text-xs">Найдите сервер во вкладке «Поиск» и отправьте его на проверку.</p>
            </Centered>
          ) : (
            <section aria-label="Проверенные серверы">
              <h2 className="px-4 pt-3 text-xs font-medium uppercase text-muted-foreground">Проверенные серверы</h2>
              <ul>
                {items.map((item) => (
                  <Row key={item.name}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
                      <Badge tone="outline">{item.version}</Badge>
                      {item.installed && <Badge>уже стоит</Badge>}
                      {item.error === null && !item.installed && (
                        <Button className="ml-auto" size="sm" variant="outline" disabled={!setup.repo} onClick={() => setInstalling(item)}>
                          Поставить
                        </Button>
                      )}
                    </div>
                    {item.summary !== "" && <p className="text-xs text-muted-foreground">{item.summary}</p>}
                    {item.error !== null && <Notice danger>{item.error}</Notice>}
                  </Row>
                ))}
              </ul>
            </section>
          )
        }
      </LoadView>
      {installing !== null && (
        <VariablesDialog
          title={`Поставить ${installing.name}`}
          description={`Версия ${installing.version}. После установки сервер нужно одобрить.`}
          submitLabel="Поставить"
          loadVariables={loadVariables}
          submit={async (values) => {
            const result = await api.install({ name: installing.name, values });
            return result.ok ? { ok: true } : { ok: false, message: result.message };
          }}
          onDone={() => {
            setInstalling(null);
            notify("success", "Поставлено. Одобрите сервер во вкладке «Стоящие».");
            onChanged();
          }}
          onClose={() => setInstalling(null)}
        />
      )}
    </div>
  );
}

function ReviewRow({
  item,
  api,
  notify,
  onChanged,
  canDecide,
}: {
  item: ReviewItem;
  api: CatalogApi;
  notify: Notify;
  onChanged: () => void;
  canDecide: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const act = async (work: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await work();
      notify("success", done);
      onChanged();
    } catch (error) {
      notify("error", messageOf(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Row>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{item.name}</span>
        <Badge tone="outline">{item.version}</Badge>
        <Badge tone={item.state === "failed" ? "danger" : "plain"}>{REVIEW_LABEL[item.state]}</Badge>
        {item.state === "ready" && (
          <div className="ml-auto flex gap-1">
            <Button size="sm" variant="outline" disabled={busy || !canDecide} onClick={() => void act(() => api.accept({ name: item.name }), "Принято в коллекцию")}>
              Принять
            </Button>
            <Button size="sm" variant="ghost" disabled={busy || !canDecide} onClick={() => void act(() => api.reject({ name: item.name }), "Отклонено")}>
              Отклонить
            </Button>
          </div>
        )}
      </div>
      {item.error !== null && <p className="text-xs text-destructive">{item.error}</p>}
    </Row>
  );
}
