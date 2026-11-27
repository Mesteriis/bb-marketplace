import { createContext, useContext, type ComponentType } from "react";

type IconProps = {name: string; className?: string; "aria-hidden"?: boolean | "false" | "true"};
const IconContext = createContext<ComponentType<IconProps> | null>(null);

/** The app hands in BB's lucide icon component; the UI layer only names icons. */
export const IconProvider = IconContext.Provider;

/** A decorative lucide icon by name (`GitPullRequest`, `Workflow`…); nothing when no component was given. */
export function Icon({name, small = false}: {name: string; small?: boolean}) {
  const Component = useContext(IconContext);
  return Component ? <Component name={name} className={"g-icon" + (small ? " s" : "")} aria-hidden/> : null;
}
