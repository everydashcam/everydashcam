import { SUPPORTED_BRANDS } from "../../vite-plugins/supported-brands.js";

export const BRAND_ALPHABET = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
const BRAND_WORD = "EVERY";
const cameraBrands = SUPPORTED_BRANDS.map((brand) => brand.displayName.toUpperCase());
const maxDrums = Math.max(BRAND_WORD.length, ...cameraBrands.map((word) => word.length));
const ROLL_MS = 1100;
const RESIZE_MS = 180;
const HOLD_MS = 350;
const WORD_EXIT_MS = 140;
const WORD_ENTER_MS = 180;

export function createBrandCycle(random: () => number = () => Math.random()): () => string {
    let remaining: string[] = [];
    let previous: string | undefined;
    return () => {
        if (remaining.length === 0) {
            remaining = [...cameraBrands];
            for (let index = remaining.length - 1; index > 0; index--) {
                const other = Math.floor(random() * (index + 1));
                [remaining[index], remaining[other]] = [remaining[other]!, remaining[index]!];
            }
            const last = remaining.length - 1;
            if (remaining[last] === previous) {
                const other = Math.floor(random() * last);
                [remaining[last], remaining[other]] = [remaining[other]!, remaining[last]!];
            }
        }
        previous = remaining.pop()!;
        return previous;
    };
}

export function initBrandMark(): void {
    const root = document.querySelector<HTMLElement>(".topbar .edc-mark");
    const deck = root?.querySelector<HTMLElement>(".edc-mark__drums");
    if (!root || !deck) return;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const hover = matchMedia("(hover: hover)");
    const compact = matchMedia("(max-width: 600px)");
    let frame: number | undefined;
    let holdTimer: ReturnType<typeof setTimeout> | undefined;
    let isHovered = false;
    let drumCount = BRAND_WORD.length;
    let orangeDrum = -1;
    let wordOpacity = 1;
    let availableWidth = 0;
    let drumWidth = 0;
    let drumGap = 0;
    let isPrepared = false;
    const drums: HTMLElement[] = [];
    const columns: HTMLElement[] = [];
    const positions: number[] = [];
    const nextBrand = createBrandCycle();

    const prepareDrums = (): void => {
        if (isPrepared) return;
        isPrepared = true;
        // Keep the original five-drum layout width; the extra drums are clipped
        // over DASHCAM, so revealing a long name cannot move toolbar controls.
        drums.push(...deck.querySelectorAll<HTMLElement>(".edc-mark__drum"));
        while (drums.length < maxDrums) {
            const drum = document.createElement("span");
            drum.className = "edc-mark__drum";
            const column = document.createElement("span");
            column.className = "edc-mark__column";
            drum.appendChild(column);
            deck.appendChild(drum);
            drums.push(drum);
        }
        columns.push(...drums.map((drum) => drum.querySelector<HTMLElement>(".edc-mark__column")!));
        positions.push(...columns.map(() => 0));
        root.classList.add("edc-mark--interactive");
        columns.forEach((column) => {
            // A second alphabet makes the final character -> blank -> A wrap seamless.
            column.replaceChildren(
                ...Array.from(BRAND_ALPHABET.repeat(2), (letter) => {
                    const span = document.createElement("span");
                    span.className = "edc-mark__letter";
                    span.textContent = letter;
                    return span;
                }),
            );
        });
        measureDeck();
        setWord(BRAND_WORD);
        setDrumCount(BRAND_WORD.length);
    };
    const measureDeck = (): void => {
        const style = getComputedStyle(root);
        drumWidth = Number.parseFloat(style.getPropertyValue("--edc-drum-width"));
        drumGap = Number.parseFloat(style.getPropertyValue("--edc-drum-gap"));
        availableWidth = root.getBoundingClientRect().width;
    };
    const setDrumCount = (count: number): void => {
        drumCount = count;
        root.style.setProperty("--edc-drum-count", String(count));
        const width = count * drumWidth + (count - 1) * drumGap;
        root.style.setProperty("--edc-deck-scale", String(compact.matches ? 1 : Math.min(1, availableWidth / width)));
        // Switch near the midpoint so the accent never moves onto a clipped-away drum.
        const last = Math.round(count) - 1;
        if (last === orangeDrum) return;
        drums[orangeDrum]?.classList.remove("edc-mark__drum--last");
        drums[last]!.classList.add("edc-mark__drum--last");
        orangeDrum = last;
    };
    const setPosition = (index: number, position: number): void => {
        positions[index] = position;
        columns[index]!.style.setProperty("--edc-letter-index", String(position));
    };
    const setWord = (word: string): void => {
        columns.forEach((_, index) => {
            setPosition(index, BRAND_ALPHABET.indexOf(word[index] ?? " "));
        });
    };
    const setWordVisibility = (opacity: number): void => {
        wordOpacity = opacity;
        root.style.setProperty("--edc-word-opacity", String(opacity));
    };
    const animate = (duration: number, update: (elapsed: number) => void, done: () => void): void => {
        let startedAt: number | undefined;
        root.classList.add("edc-mark--animated");
        const advance = (timestamp: number): void => {
            startedAt ??= timestamp;
            const elapsed = Math.min(duration, timestamp - startedAt);
            update(elapsed);
            if (elapsed < duration) {
                frame = requestAnimationFrame(advance);
            } else {
                frame = undefined;
                root.classList.remove("edc-mark--animated");
                done();
            }
        };
        frame = requestAnimationFrame(advance);
    };
    const ease = (progress: number): number => progress * progress * (3 - 2 * progress);
    const rollTo = (word: string, done: () => void): void => {
        measureDeck();
        const count = word.length;
        const fromCount = drumCount;
        let previousSpeed = 0;
        const rolls = positions.slice(0, Math.max(Math.ceil(fromCount), count)).map((start, index) => {
            const target = BRAND_ALPHABET.indexOf(word[index] ?? " ");
            const delta = (target - start + BRAND_ALPHABET.length) % BRAND_ALPHABET.length;
            const across = Math.min(index, count - 1) / (count - 1);
            // Right starts first and stops last. Only add complete turns when
            // needed to keep every right drum faster than its left neighbor.
            const delay = ROLL_MS * 0.175 * (1 - across);
            const duration = ROLL_MS * (0.5 + 0.5 * across);
            const turns = Math.max(
                delta === 0 ? 1 : 0,
                Math.ceil((previousSpeed * 1.08 * duration - delta) / BRAND_ALPHABET.length),
            );
            const distance = turns * BRAND_ALPHABET.length + delta;
            previousSpeed = distance / duration;
            return { index, start, target, delay, duration, distance };
        });
        animate(
            ROLL_MS,
            (elapsed) => {
                setDrumCount(fromCount + (count - fromCount) * ease(Math.min(1, elapsed / RESIZE_MS)));
                for (const roll of rolls) {
                    const progress = Math.min(1, Math.max(0, elapsed - roll.delay) / roll.duration);
                    const position =
                        progress === 1 ? roll.target : (roll.start + roll.distance * progress) % BRAND_ALPHABET.length;
                    setPosition(roll.index, position);
                }
            },
            () => {
                setWord(word);
                setDrumCount(count);
                done();
            },
        );
    };
    const cancelPending = (): void => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
        clearTimeout(holdTimer);
        holdTimer = undefined;
        root.classList.remove("edc-mark--animated");
    };
    const reset = (): void => {
        cancelPending();
        isHovered = false;
        if (!isPrepared) return;
        measureDeck();
        setWord(BRAND_WORD);
        setDrumCount(BRAND_WORD.length);
        setWordVisibility(1);
    };

    if (!reducedMotion.matches && !compact.matches) {
        // Let the static logo and usable toolbar paint before preparing the
        // animation. Compact and reduced-motion visits keep the original DOM.
        frame = requestAnimationFrame(() => {
            frame = requestAnimationFrame(() => {
                frame = undefined;
                if (reducedMotion.matches || compact.matches) return;
                prepareDrums();
                rollTo(BRAND_WORD, () => {});
            });
        });
    }
    const showBrand = (word: string): void => {
        rollTo(word, () => {
            holdTimer = setTimeout(() => {
                holdTimer = undefined;
                showBrand(nextBrand());
            }, HOLD_MS);
        });
    };
    root.addEventListener("mouseenter", () => {
        if (reducedMotion.matches || compact.matches || !hover.matches || isHovered) return;
        isHovered = true;
        cancelPending();
        prepareDrums();
        const word = nextBrand();
        const fromOpacity = wordOpacity;
        // Let DASHCAM leave before the deck expands into its space. Its box
        // stays in the layout, keeping every toolbar control stationary.
        if (fromOpacity === 0) {
            showBrand(word);
        } else {
            animate(
                WORD_EXIT_MS,
                (elapsed) => setWordVisibility(fromOpacity * (1 - ease(elapsed / WORD_EXIT_MS))),
                () => showBrand(word),
            );
        }
    });
    root.addEventListener("mouseleave", () => {
        if (!isHovered) return;
        isHovered = false;
        cancelPending();
        rollTo(BRAND_WORD, () => {
            const fromOpacity = wordOpacity;
            animate(
                WORD_ENTER_MS,
                (elapsed) => setWordVisibility(fromOpacity + (1 - fromOpacity) * ease(elapsed / WORD_ENTER_MS)),
                () => {},
            );
        });
    });
    reducedMotion.addEventListener("change", () => {
        if (reducedMotion.matches) reset();
    });
    compact.addEventListener("change", () => {
        if (compact.matches) reset();
    });
    hover.addEventListener("change", () => {
        if (!hover.matches) reset();
    });
}
