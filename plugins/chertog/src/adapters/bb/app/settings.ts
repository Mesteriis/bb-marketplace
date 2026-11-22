// The plugin settings a Chertog window reads. The server declares them with
// `bb.settings.define`; a window sees their effective values through the
// SDK's `useSettings()`. Until a key is declared or delivered it reads as
// off, so nothing redirects and no acceptance panel is offered by accident.

/** "Открывать Чертог вместо штатного Домой": boolean, on by default once declared. */
export const HOME_REDIRECT_SETTING = "homeRedirect";

/** "Тайловое пространство": boolean, on by default; off keeps Chertog out of the window. */
export const TILE_SPACE_SETTING = "tileSpace";

/** "Тестовая панель для приёмки": boolean, off by default. */
export const ACCEPTANCE_FIXTURE_SETTING = "acceptanceFixture";

/** `useSettings().values`: undefined while BB has not delivered them. */
export type SettingValues = Readonly<Record<string, string | number | boolean>> | undefined;

/**
 * Whether the stock Home redirects to Chertog. `null` while the values are
 * not delivered: the Home section then waits and draws nothing. A key the
 * server has not declared is absent from the values and reads as off.
 */
export function readHomeRedirect(values: SettingValues): boolean | null {
  if (values === undefined) return null;
  return values[HOME_REDIRECT_SETTING] === true;
}

/** Whether the content picker offers the acceptance panel. Off until the values say otherwise. */
export function readAcceptanceFixture(values: SettingValues): boolean {
  return values !== undefined && values[ACCEPTANCE_FIXTURE_SETTING] === true;
}

/**
 * Whether Chertog's workspace runs in the window. `null` while the values are
 * not delivered: nothing is mounted then. A missing key reads as on, so an
 * installation that never saw the switch keeps its workspace.
 */
export function readTileSpace(values: SettingValues): boolean | null {
  if (values === undefined) return null;
  return values[TILE_SPACE_SETTING] !== false;
}

/** The Home redirect after the tile space switch: with the workspace off there is nowhere to redirect to. */
export function readHomeRedirectEffective(values: SettingValues): boolean | null {
  const redirect = readHomeRedirect(values);
  if (redirect === null) return null;
  return readTileSpace(values) === false ? false : redirect;
}
