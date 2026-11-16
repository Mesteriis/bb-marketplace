export function NotificationSoundSelect({ value, current, sounds = [], label = "Notification sound", inheritLabel, disabled, change }: {
  value: string;
  current?: string;
  sounds?: { id: string; title: string }[];
  label?: string;
  inheritLabel?: string;
  disabled?: boolean;
  change: (value: string) => void;
}) {
  return <label>{label} <select value={value} disabled={disabled} onChange={(event) => change(event.currentTarget.value)}>
    {inheritLabel && <option value="inherit">{inheritLabel}</option>}
    <option value="-1">Default sound</option>
    <option value="0">No sound</option>
    {sounds.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
    {current && !["inherit", "-1", "0"].includes(current) && !sounds.some(({ id }) => id === current)
      && <option value={current}>Current sound</option>}
  </select></label>;
}
