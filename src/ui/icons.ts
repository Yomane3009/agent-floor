// Phosphor icons (regular weight), inlined as SVG strings at build time.
import x from '@phosphor-icons/core/assets/regular/x.svg?raw';
import sun from '@phosphor-icons/core/assets/regular/sun.svg?raw';
import moon from '@phosphor-icons/core/assets/regular/moon.svg?raw';
import plug from '@phosphor-icons/core/assets/regular/plug.svg?raw';
import cornersOut from '@phosphor-icons/core/assets/regular/corners-out.svg?raw';
import copy from '@phosphor-icons/core/assets/regular/copy.svg?raw';
import check from '@phosphor-icons/core/assets/regular/check.svg?raw';
import play from '@phosphor-icons/core/assets/regular/play.svg?raw';
import github from '@phosphor-icons/core/assets/regular/github-logo.svg?raw';
import crosshair from '@phosphor-icons/core/assets/regular/crosshair.svg?raw';
import replay from '@phosphor-icons/core/assets/regular/clock-counter-clockwise.svg?raw';
import pause from '@phosphor-icons/core/assets/regular/pause.svg?raw';
import broadcast from '@phosphor-icons/core/assets/regular/broadcast.svg?raw';

export const icons = { x, sun, moon, plug, cornersOut, copy, check, play, github, crosshair, replay, pause, broadcast };
export type IconName = keyof typeof icons;

export function icon(name: IconName) {
  return icons[name].replace('<svg ', '<svg aria-hidden="true" focusable="false" class="icon" ');
}
