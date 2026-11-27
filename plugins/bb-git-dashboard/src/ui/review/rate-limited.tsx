/** A read refused by the forge's rate limit: when it is tried again, and a way to try now. */
export function RateLimited({left, onNow}: {left: number; onNow(): void}) {
  return <p className="git-muted" role="status">The forge’s rate limit is reached; reading again in {left} s.{" "}
    <button type="button" onClick={onNow}>Try now</button></p>;
}
