interface InertOwner {
    count: number;
    original: boolean;
}

// Fullscreen and a dialog can isolate the same background at once. Releasing
// either owner must not make the other's background interactive.
const owners = new Map<HTMLElement, InertOwner>();

export function isolateBackground(active: HTMLElement, exclude?: (element: HTMLElement) => boolean): () => void {
    const acquired: HTMLElement[] = [];
    for (let child: Element = active; child.parentElement; child = child.parentElement) {
        for (const sibling of child.parentElement.children) {
            if (sibling === child || !(sibling instanceof HTMLElement) || exclude?.(sibling)) continue;
            let owner = owners.get(sibling);
            if (!owner) {
                owner = { count: 0, original: sibling.inert };
                owners.set(sibling, owner);
            }
            owner.count++;
            sibling.inert = true;
            acquired.push(sibling);
        }
    }
    return () => {
        for (const element of acquired.splice(0)) {
            const owner = owners.get(element)!;
            if (--owner.count === 0) {
                element.inert = owner.original;
                owners.delete(element);
            }
        }
    };
}
