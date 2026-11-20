// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { expect, test, vi } from "vitest";
import { CinemaVideo } from "../src/ui/cinema-video.tsx";

test("seeks on repeated edge taps within a portrait frame and can reset its rotation", () => {
  const player = createRef<HTMLVideoElement>();
  const seek = vi.fn((time: number) => { if (player.current) player.current.currentTime = time; });
  const toggle = vi.fn();
  const { container } = render(<CinemaVideo video={<video ref={player} />} player={player} source="/fixture.mp4"
    duration={60} position={25} playing={false} seek={seek} toggle={toggle}
    fullscreen={false} preview={false} settings={null} shortcuts />);
  const picture = container.querySelector<HTMLElement>(".mtg-cinema-picture")!;
  vi.spyOn(picture, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 1000, 500));
  Object.defineProperties(player.current, { videoWidth: { value: 360 }, videoHeight: { value: 640 } });
  player.current!.currentTime = 25;

  function tap(x: number) {
    for (const type of ["pointerdown", "pointerup"]) {
      const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 250 });
      Object.defineProperty(event, "isPrimary", { value: true });
      fireEvent(picture, event);
    }
  }
  tap(610);
  expect(seek).not.toHaveBeenCalled();
  tap(610);
  expect(seek).toHaveBeenLastCalledWith(35);
  tap(390);
  tap(390);
  expect(seek).toHaveBeenLastCalledWith(25);
  expect(toggle).not.toHaveBeenCalled();
  tap(500);
  expect(toggle).toHaveBeenCalledOnce();

  fireEvent.click(screen.getByText("Rotate 90°"));
  expect(picture.dataset.quarterTurn).toBe("true");
  fireEvent.click(screen.getByText("Reset rotation"));
  expect(picture.dataset.quarterTurn).toBeUndefined();
});
