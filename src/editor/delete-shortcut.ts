type ElementLike = {
  tagName?: string
  isContentEditable?: boolean
  parentElement?: ElementLike | null
  getAttribute?: (name: string) => string | null
}

function asElementLike(target: EventTarget | null): ElementLike | undefined {
  if (typeof target !== 'object' || target === null) return undefined
  return target as ElementLike
}

/** True when a keyboard event target belongs to a text-editing control. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  let element = asElementLike(target)
  const visited = new Set<ElementLike>()

  while (element && !visited.has(element)) {
    visited.add(element)
    const tagName = element.tagName?.toUpperCase()
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true
    if (element.isContentEditable === true) return true

    const contentEditable = element.getAttribute?.('contenteditable')
    if (contentEditable !== undefined && contentEditable !== null && contentEditable.toLowerCase() !== 'false') {
      return true
    }
    element = element.parentElement ?? undefined
  }

  return false
}

/**
 * Decide whether the application should handle this event as model deletion.
 * This function has no side effects; the caller remains responsible for
 * preventing the browser default and executing the delete command.
 */
export function shouldHandleDeleteShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (event.key !== 'Backspace' && event.key !== 'Delete') return false
  return !isTextEditingTarget(event.target)
}
