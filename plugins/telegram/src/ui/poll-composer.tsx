import { useTelegramLocale } from "./i18n/index.tsx";
import { ChartNoAxesColumn } from "lucide-react";
import { ComposerActionEntry } from "./composer-actions.tsx";
import { createContext, useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { isPhotoMimeType, maxOriginalPhotoBytes, photoAccept, preparePhoto } from "./prepare-photo.ts";
import { importMotionPhoto } from "./import-motion-photo.ts";
import { InstalledStickerPicker, type StickerChoice } from "./installed-sticker-picker.tsx";
import { PollStickerActions } from "./poll-stickers.tsx";
import { LocationCardFields, parseLocationCardFields, type LocationCardFieldsValue } from "./location-card-fields.tsx";
import { isVideoAttachmentName, maxTelegramUploadBytes, pollDraft, videoAttachmentAccept, type PollUploadFile, type ChannelPollLimits, type ForumTopicTarget, type MediaReply, type PollDraft, type PollSendResult, type PollSender } from "../core/contract.ts";

const emptyPlace = { latitude: "", longitude: "", title: "", address: "" };
type PlaceField = PollUploadFile["slot"];
type PollFileSelection = { file: File; kind: Exclude<PollUploadFile["kind"], "livePhoto">; slot: PlaceField };
type PollLocalFile = PollFileSelection | { file: File; kind: "livePhoto"; slot: PlaceField; photo: string | File };
type LivePhotoSelection = { still?: File; clip?: File };
type PollShortcutFileUpload = (draft: PollDraft, files: PollLocalFile[], signal: AbortSignal,
  progress: (offset: number, total: number, canCancel: boolean) => void) => Promise<{ state: PollSendResult["state"] | "cancelled" }>;
export const PollFileUpload = createContext<((target: string | { id?: number; name: string }, ...args: [
  ...Parameters<PollShortcutFileUpload>, topic?: ForumTopicTarget, reply?: MediaReply,
]) => Promise<{ state: PollSendResult["state"] | "submitted" | "changed" | "cancelled" }>) | undefined>(undefined);

function parsePlace(draft: LocationCardFieldsValue | undefined) {
  if (!draft || !Object.values(draft).some((value) => value.trim())) return;
  return parseLocationCardFields(draft) ?? null;
}

function PollPhotoField({ label, file, update, disabled }: {
  label: string; file?: File; update: (file?: File) => void; disabled: boolean;
}) {
  const { t: tr } = useTelegramLocale();
  const [preview, setPreview] = useState<string>();
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!file) { setPreview(undefined); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <fieldset disabled={disabled}>
    <legend>{label}</legend>
    <label>{tr("Choose photo ")}<input type="file" accept={photoAccept} onChange={(event) => {
      const input = event.currentTarget;
      const selected = input.files?.[0];
      input.value = "";
      if (!selected) return;
      const valid = isPhotoMimeType(selected.type) && selected.size > 0 && selected.size <= maxOriginalPhotoBytes;
      setError(!valid);
      if (valid) update(selected);
    }} /></label>
    {file && <div>
      {preview && <img className="mtg-poll-photo-draft" src={preview} alt={tr("Selected photo")} />}
      <bdi>{file.name}</bdi>
      <button type="button" className="mtg-action" onClick={() => { setError(false); update(undefined); }}>{tr("Remove photo")}</button>
    </div>}
    {error && <p role="alert">{tr("Choose a JPEG, PNG or WebP photo up to 64 MiB.")}</p>}
  </fieldset>;
}

export function PollComposer(props: {
  chatId: string; topic?: ForumTopicTarget; reply?: MediaReply; send: PollSender; onSent?: () => void; allowVisibleVotes?: boolean;
  loadChannelLimits?: (chatId: string) => Promise<ChannelPollLimits | null>;
} | { saveToShortcut: (draft: PollDraft) => ReturnType<PollShortcutFileUpload>;
  uploadToShortcut?: PollShortcutFileUpload; cancelShortcut: () => void }) {
  const { t: tr } = useTelegramLocale();
  const shortcut = "saveToShortcut" in props;
  const upload = useContext(PollFileUpload);
  const submitFiles: PollShortcutFileUpload | undefined = shortcut ? props.uploadToShortcut
    : upload && (async (draft, files, signal, progress) => {
      const result = await upload(props.chatId, draft, files, signal, progress, props.topic, props.reply);
      return result.state === "changed" || result.state === "submitted" ? { state: "unknown" } : { state: result.state };
    });
  const stickerActions = useContext(PollStickerActions);
  const [stickers, setStickers] = useState<Partial<Record<number, StickerChoice>>>({});
  const [stickerOption, setStickerOption] = useState<number>();
  const [files, setFiles] = useState<Partial<Record<PlaceField, PollFileSelection>>>({});
  const [livePhotos, setLivePhotos] = useState<Partial<Record<PlaceField, LivePhotoSelection>>>({});
  const [livePhotoErrors, setLivePhotoErrors] = useState<Partial<Record<PlaceField, string>>>({});
  const imports = useRef(new Map<PlaceField, symbol>());
  const [importCount, setImportCount] = useState(0);
  const [fileErrors, setFileErrors] = useState<Partial<Record<PlaceField, string>>>({});
  const [progress, setProgress] = useState<{ offset: number; total: number; canCancel: boolean }>();
  const activeUpload = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => { activeUpload.current?.abort(); imports.current.clear(); }, []);
  const allowVisibleVotes = !shortcut && props.allowVisibleVotes === true;
  const loadChannelLimits = !shortcut ? props.loadChannelLimits : undefined;
  const [limits, setLimits] = useState<ChannelPollLimits | "loading" | "unavailable">();
  const [membersOnly, setMembersOnly] = useState(false);
  const [countries, setCountries] = useState<string[]>([]);
  const [country, setCountry] = useState("");
  const [open, setOpen] = useState(shortcut);
  const [question, setQuestion] = useState("");
  const [description, setDescription] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [links, setLinks] = useState<Record<number, string>>({});
  const [photos, setPhotos] = useState<Partial<Record<PlaceField, File>>>({});
  const [photoError, setPhotoError] = useState(false);
  const [places, setPlaces] = useState<Partial<Record<PlaceField, LocationCardFieldsValue>>>({});
  const optionLinks = options.flatMap((_, index) => links[index]?.trim() ? [{ index, url: links[index] }] : []);
  const [multiple, setMultiple] = useState(false);
  const [visibleVotes, setVisibleVotes] = useState(false);
  const [allowSuggestions, setAllowSuggestions] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [disableRevoting, setDisableRevoting] = useState(false);
  const [duration, setDuration] = useState("");
  const [hideResults, setHideResults] = useState(false);
  const [quiz, setQuiz] = useState(false);
  const [correctIndexes, setCorrectIndexes] = useState<number[]>([]);
  const [explanation, setExplanation] = useState("");
  const [status, setStatus] = useState<PollSendResult["state"] | "sending" | "cancelled">();
  const questionPlace = parsePlace(places.question);
  const explanationPlace = quiz ? parsePlace(places.explanation) : undefined;
  const parsedOptionPlaces = options.map((_, index) => parsePlace(places[index]));
  const optionPlaces = parsedOptionPlaces.flatMap((place, index) => place ? [{ ...place, index }] : []);
  const optionStickers = options.flatMap((_, index) => {
    const choice = stickers[index];
    return choice ? [{ index, packId: choice.packId, fileId: choice.fileId }] : [];
  });
  const multipleAttachments = (...items: unknown[]) => items.filter(Boolean).length > 1;
  const conflictingAttachment = multipleAttachments(photos.question, questionPlace, files.question, livePhotos.question)
    || quiz && multipleAttachments(photos.explanation, explanationPlace, files.explanation, livePhotos.explanation)
    || options.some((_, index) => multipleAttachments(files[index], photos[index], parsedOptionPlaces[index], links[index]?.trim(), stickers[index], livePhotos[index]));
  const slots: PlaceField[] = ["question", ...options.map((_, index) => index), ...(quiz ? ["explanation" as const] : [])];
  const incompleteLivePhoto = slots.some((slot) => {
    const pair = livePhotos[slot];
    return pair && (!pair.still || !pair.clip);
  });
  const badPlace = questionPlace === null || explanationPlace === null || parsedOptionPlaces.includes(null);
  const parsed = pollDraft.safeParse({ question, options, multiple: quiz ? correctIndexes.length > 1 : multiple,
    ...(description.trim() ? { description } : {}),
    ...(optionLinks.length ? { optionLinks } : {}),
    ...(optionStickers.length ? { optionStickers } : {}),
    ...(questionPlace ? { questionPlace } : {}),
    ...(optionPlaces.length ? { optionPlaces } : {}),
    ...(shuffle ? { shuffle } : {}),
    ...(!quiz && disableRevoting ? { disableRevoting } : {}),
    ...(duration ? { durationMinutes: Number(duration), hideResultsUntilClosed: hideResults } : {}),
    ...(loadChannelLimits && membersOnly ? { membersOnly: true } : {}),
    ...(loadChannelLimits && countries.length ? { countryCodes: countries } : {}),
    ...(allowVisibleVotes && visibleVotes ? { anonymous: false, ...(!quiz && allowSuggestions ? { allowSuggestions: true } : {}) } : {}),
    ...(quiz ? { quiz: { correctIndexes, explanation, ...(explanationPlace && { place: explanationPlace }) } } : {}),
  });
  const busy = status === "sending";
  const valid = parsed.success && !badPlace && !conflictingAttachment && !incompleteLivePhoto && importCount === 0;

  function placeFields(field: PlaceField, label: string) {
    return <fieldset disabled={busy}>
      <legend>{label}</legend>
      <LocationCardFields draft={places[field] ?? emptyPlace} update={(place) => setPlaces((previous) => ({ ...previous, [field]: place }))} />
    </fieldset>;
  }

  function photoField(field: PlaceField, label: string) {
    return <PollPhotoField label={label} file={photos[field]} disabled={busy}
      update={(file) => setPhotos((previous) => ({ ...previous, [field]: file }))} />;
  }

  function cancelImport(slot: PlaceField) {
    if (imports.current.delete(slot)) setImportCount(imports.current.size);
  }

  function livePhotoField(slot: PlaceField, label: string) {
    const pair = livePhotos[slot];
    return <fieldset disabled={busy}>
      <legend>{label}</legend>
      <label>{tr("Import Motion Photo ")}<input type="file" accept="image/jpeg,image/avif,image/heic,.jpg,.jpeg,.avif,.heic" onChange={async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        const token = Symbol();
        imports.current.set(slot, token);
        setImportCount(imports.current.size);
        const imported = await importMotionPhoto(file).catch(() => undefined);
        if (imports.current.get(slot) !== token) return;
        cancelImport(slot);
        if (imported) setLivePhotos((previous) => ({ ...previous, [slot]: imported }));
        setLivePhotoErrors((previous) => ({ ...previous, [slot]: imported ? undefined : "Could not read a Motion Photo." }));
      }} /></label>
      <label>{tr("Still image ")}<input type="file" accept={`${photoAccept},image/heic,.heic`} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        cancelImport(slot);
        const heic = file.type === "image/heic" || /\.heic$/i.test(file.name);
        const valid = !!file.size && file.size <= maxOriginalPhotoBytes && (heic || isPhotoMimeType(file.type));
        if (valid) setLivePhotos((previous) => ({ ...previous, [slot]: { ...previous[slot],
          still: heic && file.type !== "image/heic" ? new File([file], file.name, { type: "image/heic" }) : file } }));
        setLivePhotoErrors((previous) => ({ ...previous, [slot]: valid ? undefined : "Choose a JPEG, PNG, WebP or HEIC image." }));
      }} /></label>
      {pair?.still && <bdi>{pair.still.name}</bdi>}
      <label>{tr("Motion clip ")}<input type="file" accept={videoAttachmentAccept} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        cancelImport(slot);
        const valid = !!file.size && file.size <= maxTelegramUploadBytes && isVideoAttachmentName(file.name);
        if (valid) setLivePhotos((previous) => ({ ...previous, [slot]: { ...previous[slot], clip: file } }));
        setLivePhotoErrors((previous) => ({ ...previous, [slot]: valid ? undefined : "Choose an MP4 or MOV clip." }));
      }} /></label>
      {pair?.clip && <bdi>{pair.clip.name}</bdi>}
      {(pair || imports.current.has(slot)) && <button type="button" className="mtg-action" onClick={() => {
        cancelImport(slot);
        setLivePhotos((previous) => ({ ...previous, [slot]: undefined }));
        setLivePhotoErrors((previous) => ({ ...previous, [slot]: undefined }));
      }}>{tr("Remove live photo")}</button>}
      {livePhotoErrors[slot] && <p role="alert">{livePhotoErrors[slot]}</p>}
    </fieldset>;
  }

  function fileField(slot: PlaceField, label: string) {
    const selected = files[slot];
    return <fieldset disabled={busy}>
      <legend>{label}</legend>
      <label>{tr("Choose file ")}<input type="file" accept={typeof slot === "number" ? `${videoAttachmentAccept},.gif` : undefined} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        const kind = /\.gif$/i.test(file.name) ? "gif" : isVideoAttachmentName(file.name) ? "video"
          : /\.(?:mp3|m4a)$/i.test(file.name) ? "audio" : "document";
        const allowed = typeof slot !== "number" || kind === "gif" || kind === "video";
        const error = !allowed ? "Choose an MP4, MOV or GIF for this answer."
          : file.size <= 0 || file.size > maxTelegramUploadBytes ? "The file has an unsupported size." : undefined;
        setFileErrors((previous) => ({ ...previous, [slot]: error }));
        if (!error) setFiles((previous) => ({ ...previous, [slot]: { slot, kind, file } }));
      }} /></label>
      {selected && <div><bdi>{selected.file.name}</bdi> <button type="button" className="mtg-action"
        onClick={() => setFiles((previous) => ({ ...previous, [slot]: undefined }))}>{tr("Remove file")}</button></div>}
      {fileErrors[slot] && <p role="alert">{fileErrors[slot]}</p>}
    </fieldset>;
  }

  async function loadRestrictions() {
    if (shortcut || !loadChannelLimits || limits === "loading") return;
    setLimits("loading");
    const available = await loadChannelLimits(props.chatId).catch(() => null);
    setLimits(available ?? "unavailable");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || busy) return;
    setStatus("sending");
    setPhotoError(false);
    const draft = parsed.data;
    const selectedFiles: PollLocalFile[] = Object.values(files).filter((file): file is PollFileSelection => !!file && (file.slot !== "explanation" || quiz));
    try {
      if (photos.question) draft.questionPhoto = await preparePhoto(photos.question);
      if (draft.quiz && photos.explanation) draft.quiz.photo = await preparePhoto(photos.explanation);
      const optionPhotos: NonNullable<PollDraft["optionPhotos"]> = [];
      for (const [index] of options.entries()) {
        const file = photos[index];
        if (file) optionPhotos.push({ index, base64: await preparePhoto(file) });
      }
      if (optionPhotos.length) draft.optionPhotos = optionPhotos;
      for (const slot of slots) {
        const pair = livePhotos[slot];
        if (pair?.still && pair.clip) selectedFiles.push({ slot, kind: "livePhoto", file: pair.clip,
          photo: pair.still.type === "image/heic" ? pair.still : await preparePhoto(pair.still) });
      }
    } catch {
      setStatus(undefined);
      setPhotoError(true);
      return;
    }
    const send = async () => {
      if (submitFiles && selectedFiles.length) {
        const controller = new AbortController();
        activeUpload.current = controller;
        setProgress({ offset: 0, total: selectedFiles.reduce((total, item) => total + item.file.size
          + (item.kind === "livePhoto" && typeof item.photo !== "string" ? item.photo.size : 0), 0), canCancel: true });
        try {
          return await submitFiles(draft, selectedFiles, controller.signal,
            (offset, total, canCancel) => setProgress({ offset, total, canCancel }));
        } finally {
          activeUpload.current = undefined;
          setProgress(undefined);
        }
      }
      if (shortcut) return props.saveToShortcut(draft);
      return props.reply ? props.send(props.chatId, draft, props.topic, props.reply) : props.send(props.chatId, draft, props.topic);
    };
    const result = await send().catch(() => ({ state: "unknown" as const }));
    setStatus(result.state);
    if (result.state === "sent") {
      if (!shortcut) props.onSent?.();
      setQuestion("");
      setDescription("");
      setOptions(["", ""]);
      setLinks({});
      setPlaces({});
      setPhotos({});
      setLivePhotos({});
      setLivePhotoErrors({});
      setFiles({});
      setFileErrors({});
      setStickers({});
      setStickerOption(undefined);
      setMultiple(false);
      setVisibleVotes(false);
      setAllowSuggestions(false);
      setMembersOnly(false);
      setCountries([]);
      setCountry("");
      setShuffle(false);
      setDisableRevoting(false);
      setDuration("");
      setHideResults(false);
      setQuiz(false);
      setCorrectIndexes([]);
      setExplanation("");
      setOpen(false);
    }
  }

  return <>
    {!open && <div className="mtg-poll-compose">
      <ComposerActionEntry primary><button type="button" className="mtg-action" onClick={() => { setStatus(undefined); setOpen(true); }}>
        <ChartNoAxesColumn size={15} aria-hidden="true" />{tr(" Create poll")}</button></ComposerActionEntry>
      {status === "sent" && <span role="status">{tr("Poll published.")}</span>}
    </div>}
    {open && <form className="mtg-edit" aria-label={shortcut ? tr("Add poll to quick reply") : tr("Create Telegram poll")} onSubmit={(event) => void submit(event)}>
      <label>{tr("Question ")}<input autoFocus value={question} maxLength={255} disabled={busy}
        onChange={(event) => setQuestion(event.currentTarget.value)} /></label>
      {options.map((option, index) => <label key={index}>{tr("Option ")}{index + 1}
        <input value={option} maxLength={100} disabled={busy} onChange={(event) => {
          const text = event.currentTarget.value;
          setOptions((previous) => previous.map((value, i) => i === index ? text : value));
        }} />
      </label>)}
      <details>
        <summary>{tr("Links for answer options")}</summary>
        {options.map((_, index) => <label key={index}>{tr("Link for option ")}{index + 1}
          <input type="url" maxLength={4096} disabled={busy} value={links[index] ?? ""}
            onChange={(event) => {
              const url = event.currentTarget.value;
              setLinks((previous) => ({ ...previous, [index]: url }));
            }} />
        </label>)}
      </details>
      <details>
        <summary>{tr("Locations for this poll")}</summary>
        {placeFields("question", "Question location")}
        {options.map((_, index) => <div key={index}>{placeFields(index, `Location for option ${index + 1}`)}</div>)}
        {quiz && placeFields("explanation", "Explanation location")}
      </details>
      <details>
        <summary>{tr("Photos for this poll")}</summary>
        {photoField("question", "Question photo")}
        {options.map((_, index) => <div key={index}>{photoField(index, `Photo for option ${index + 1}`)}</div>)}
        {quiz && photoField("explanation", "Explanation photo")}
      </details>
      {submitFiles && <details>
        <summary>{tr("Files for this poll")}</summary>
        {fileField("question", "Question file")}
        {options.map((_, index) => <div key={index}>{fileField(index, `File for option ${index + 1}`)}</div>)}
        {quiz && fileField("explanation", "Explanation file")}
      </details>}
      {submitFiles && <details>
        <summary>{tr("Live photos for this poll")}</summary>
        {livePhotoField("question", "Question live photo")}
        {options.map((_, index) => <div key={index}>{livePhotoField(index, `Live photo for option ${index + 1}`)}</div>)}
        {quiz && livePhotoField("explanation", "Explanation live photo")}
      </details>}
      {stickerActions && <details>
        <summary>{tr("Stickers for answer options")}</summary>
        {options.map((_, index) => <fieldset key={index} disabled={busy}>
          <legend>{tr("Sticker for option ")}{index + 1}</legend>
          {stickers[index] && <>
            <p><bdi>{stickers[index]?.label}</bdi></p>
            <button type="button" className="mtg-action" onClick={() => setStickers((previous) => ({ ...previous, [index]: undefined }))}>{tr("Remove sticker")}</button>
          </>}
          {stickerOption === index ? <>
            <InstalledStickerPicker list={stickerActions.list} load={stickerActions.page} busy={busy}
              label={tr("Sticker pack")} choose={(choice) => {
                setStickers((previous) => ({ ...previous, [index]: choice }));
                setStickerOption(undefined);
              }} />
            <button type="button" className="mtg-action" onClick={() => setStickerOption(undefined)}>{tr("Close sticker picker")}</button>
          </> : <button type="button" className="mtg-action" onClick={() => setStickerOption(index)}>{tr("Choose sticker")}</button>}
        </fieldset>)}
      </details>}
      {progress && <div>
        <label>{tr("File upload ")}<progress value={progress.offset} max={progress.total} /></label>
        {progress.canCancel && <button type="button" className="mtg-action" onClick={() => activeUpload.current?.abort()}>{tr("Cancel upload")}</button>}
      </div>}
      {status === "cancelled" && <p role="status">{tr("Upload cancelled.")}</p>}
      {photoError && <p role="alert">{tr("Could not prepare a selected photo. Replace it and try again.")}</p>}
      {badPlace && <p role="status">{tr("Fill both coordinates for each location. A named place also needs a name and address.")}</p>}
      {conflictingAttachment && <p role="status">{tr("Choose one attachment for each question, answer or explanation.")}</p>}
      {incompleteLivePhoto && <p role="status">{tr("Choose both a still image and a motion clip for each live photo.")}</p>}
      <div>
        <button type="button" className="mtg-action" disabled={busy || options.length >= 10}
          onClick={() => setOptions((previous) => [...previous, ""])}>{tr("Add an option")}</button>
        <button type="button" className="mtg-action" disabled={busy || options.length <= 1}
          onClick={() => {
            setCorrectIndexes((previous) => previous.filter((index) => index < options.length - 1));
            setOptions((previous) => previous.slice(0, -1));
            setLinks((previous) => ({ ...previous, [options.length - 1]: "" }));
            setPlaces((previous) => ({ ...previous, [options.length - 1]: undefined }));
            setPhotos((previous) => ({ ...previous, [options.length - 1]: undefined }));
            cancelImport(options.length - 1);
            setLivePhotos((previous) => ({ ...previous, [options.length - 1]: undefined }));
            setLivePhotoErrors((previous) => ({ ...previous, [options.length - 1]: undefined }));
            setFiles((previous) => ({ ...previous, [options.length - 1]: undefined }));
            setFileErrors((previous) => ({ ...previous, [options.length - 1]: undefined }));
            setStickers((previous) => ({ ...previous, [options.length - 1]: undefined }));
            setStickerOption((previous) => previous === options.length - 1 ? undefined : previous);
          }}>{tr("Remove last option")}</button>
      </div>
      <label><input type="checkbox" disabled={busy} checked={quiz}
        onChange={(event) => setQuiz(event.currentTarget.checked)} />{tr(" Quiz mode")}</label>
      {quiz ? <>
        <fieldset disabled={busy}>
          <legend>{tr("Correct answers")}</legend>
          {options.map((option, index) => <label key={index}>
            <input type="checkbox" checked={correctIndexes.includes(index)}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setCorrectIndexes((previous) => checked ? [...previous, index] : previous.filter((value) => value !== index));
              }} />{tr(" Option ")}{index + 1}{option.trim() ? ` · ${option.trim()}` : ""}
          </label>)}
        </fieldset>
        <label>{tr("Explanation (optional) ")}<textarea rows={3} value={explanation} maxLength={200} disabled={busy}
          onChange={(event) => setExplanation(event.currentTarget.value)} /></label>
        {explanation.trim().split("\n").length > 3 && <p role="alert">{tr("Use at most three lines in the explanation.")}</p>}
      </> : <label><input type="checkbox" disabled={busy} checked={multiple}
        onChange={(event) => setMultiple(event.currentTarget.checked)} />{tr(" Allow multiple answers")}</label>}
      <details>
        <summary>{tr("More poll settings")}</summary>
        <label>{tr("Description (optional) ")}<textarea rows={3} value={description} maxLength={1024} disabled={busy}
          onChange={(event) => setDescription(event.currentTarget.value)} /></label>
        <label><input type="checkbox" disabled={busy} checked={shuffle}
          onChange={(event) => setShuffle(event.currentTarget.checked)} />{tr(" Shuffle answers")}</label>
        {!quiz && <label><input type="checkbox" disabled={busy} checked={disableRevoting}
          onChange={(event) => setDisableRevoting(event.currentTarget.checked)} />{tr(" Prevent changing votes")}</label>}
        <label>{tr("Close after (minutes, optional) ")}<input type="number" min={1} step={1} value={duration} disabled={busy}
          onChange={(event) => setDuration(event.currentTarget.value)} /></label>
        {duration && <label><input type="checkbox" disabled={busy} checked={hideResults}
          onChange={(event) => setHideResults(event.currentTarget.checked)} />{tr(" Hide results until the poll closes")}</label>}
      </details>
      {loadChannelLimits && <fieldset disabled={busy}>
        <legend>{tr("Who can vote")}</legend>
        {limits === "loading" ? <p role="status">{tr("Loading voting restrictions…")}</p>
          : limits === undefined || limits === "unavailable" ? <>
            {limits === "unavailable" && <p role="status">{tr("Voting restrictions are unavailable for this channel.")}</p>}
            <button type="button" className="mtg-action" onClick={() => void loadRestrictions()}>
              {limits === "unavailable" ? tr("Retry voting restrictions") : tr("Set voting restrictions")}
            </button>
          </> : <>
            <label><input type="checkbox" checked={membersOnly}
              onChange={(event) => setMembersOnly(event.currentTarget.checked)} />{tr(" Subscribers of at least 24 hours")}</label>
            {limits.countryLimit > 0 && limits.countries.length > 0 && <>
              <label>{tr("Allowed country ")}<select value={country}
                disabled={countries.length >= limits.countryLimit}
                onChange={(event) => setCountry(event.currentTarget.value)}>
                <option value="">{tr("Choose a country")}</option>
                {limits.countries.filter(({ code }) => !countries.includes(code)).map(({ code, name }) =>
                  <option key={code} value={code}>{name}</option>)}
              </select></label>
              <button type="button" className="mtg-action" disabled={!country || countries.length >= limits.countryLimit}
                onClick={() => { setCountries((previous) => [...previous, country]); setCountry(""); }}>{tr("Add country")}</button>
              {countries.length ? <ul>{countries.map((code) => {
                const name = limits.countries.find((item) => item.code === code)?.name ?? code;
                return <li key={code}>{name} <button type="button" className="mtg-action" aria-label={tr("Remove {0}", [name])}
                  onClick={() => setCountries((previous) => previous.filter((item) => item !== code))}>{tr("Remove")}</button></li>;
              })}</ul> : <p>{tr("Voters in any country can participate.")}</p>}
            </>}
          </>}
      </fieldset>}
      {allowVisibleVotes
        ? <label><input type="checkbox" disabled={busy} checked={visibleVotes}
          onChange={(event) => setVisibleVotes(event.currentTarget.checked)} />{tr(" Show who voted for each option")}</label>
        : <p>{tr("Votes are anonymous.")}</p>}
      {allowVisibleVotes && visibleVotes && !quiz && <label><input type="checkbox" disabled={busy} checked={allowSuggestions}
        onChange={(event) => setAllowSuggestions(event.currentTarget.checked)} />{tr(" Let participants suggest answers")}</label>}
      {status === "unavailable" && <p role="alert">{shortcut ? tr("This TDLib version cannot save this poll to a shortcut.")
        : tr("This TDLib version does not support publishing this poll from BB.")}</p>}
      {status === "failed" && !shortcut && <p role="alert">{tr("Telegram refused the poll. Your draft is still here.")}</p>}
      {status === "unknown" && <p role="alert">{shortcut ? tr("Telegram did not confirm the poll. Check the shortcut before retrying.")
        : tr("Telegram did not confirm the poll. Check the chat before retrying.")}</p>}
      <div>
        <button type="button" className="mtg-action" disabled={busy} onClick={shortcut ? props.cancelShortcut
          : () => { setOpen(false); setStatus(undefined); }}>{tr("Close poll editor")}</button>
        <button type="submit" className="mtg-action" disabled={busy || !valid}>
          {shortcut ? busy ? tr("Saving poll…") : tr("Save poll") : busy ? tr("Publishing poll…") : tr("Publish poll")}
        </button>
      </div>
    </form>}
  </>;
}
