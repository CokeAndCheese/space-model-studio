import { describe, expect, it } from 'vitest'
import {
  isTextEditingTarget,
  shouldHandleDeleteShortcut,
} from '../src/editor/delete-shortcut'

type FakeElement = {
  tagName: string
  isContentEditable?: boolean
  parentElement?: FakeElement | null
  getAttribute?: (name: string) => string | null
}

function element(
  tagName: string,
  options: {
    parent?: FakeElement
    contentEditable?: boolean | '' | 'true' | 'plaintext-only' | 'false'
  } = {},
): FakeElement {
  const contentEditable = options.contentEditable
  return {
    tagName,
    parentElement: options.parent ?? null,
    ...(typeof contentEditable === 'boolean' ? { isContentEditable: contentEditable } : {}),
    getAttribute: (name) => (
      name === 'contenteditable' && typeof contentEditable === 'string'
        ? contentEditable
        : null
    ),
  }
}

function keyboardEvent(
  key: string,
  options: Partial<Pick<KeyboardEvent,
    'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'defaultPrevented' | 'target'>> = {},
): KeyboardEvent {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    target: element('DIV') as unknown as EventTarget,
    ...options,
  } as KeyboardEvent
}

describe('delete shortcut safety', () => {
  it('accepts Backspace and Delete on a non-editing target', () => {
    expect(shouldHandleDeleteShortcut(keyboardEvent('Backspace'))).toBe(true)
    expect(shouldHandleDeleteShortcut(keyboardEvent('Delete'))).toBe(true)
    expect(shouldHandleDeleteShortcut(keyboardEvent('Enter'))).toBe(false)
  })

  it('ignores events already handled or carrying command modifiers', () => {
    expect(shouldHandleDeleteShortcut(keyboardEvent('Delete', { defaultPrevented: true }))).toBe(false)
    expect(shouldHandleDeleteShortcut(keyboardEvent('Delete', { metaKey: true }))).toBe(false)
    expect(shouldHandleDeleteShortcut(keyboardEvent('Delete', { ctrlKey: true }))).toBe(false)
    expect(shouldHandleDeleteShortcut(keyboardEvent('Delete', { altKey: true }))).toBe(false)
    expect(shouldHandleDeleteShortcut(keyboardEvent('Delete', { shiftKey: true }))).toBe(true)
  })

  it.each(['INPUT', 'textarea', 'Select'])('ignores a focused %s control', (tagName) => {
    const target = element(tagName) as unknown as EventTarget
    expect(isTextEditingTarget(target)).toBe(true)
    expect(shouldHandleDeleteShortcut(keyboardEvent('Delete', { target }))).toBe(false)
  })

  it('ignores descendants of editing controls', () => {
    const select = element('SELECT')
    const option = element('OPTION', { parent: select })
    expect(shouldHandleDeleteShortcut(keyboardEvent('Backspace', {
      target: option as unknown as EventTarget,
    }))).toBe(false)
  })

  it('ignores contenteditable elements and their descendants', () => {
    const editor = element('DIV', { contentEditable: 'true' })
    const child = element('SPAN', { parent: editor })
    const effectiveEditableChild = element('SPAN', { contentEditable: true })

    expect(isTextEditingTarget(editor as unknown as EventTarget)).toBe(true)
    expect(isTextEditingTarget(child as unknown as EventTarget)).toBe(true)
    expect(shouldHandleDeleteShortcut(keyboardEvent('Delete', {
      target: effectiveEditableChild as unknown as EventTarget,
    }))).toBe(false)
  })

  it('treats an explicit contenteditable=false target as non-editing', () => {
    const target = element('DIV', { contentEditable: 'false' }) as unknown as EventTarget
    expect(isTextEditingTarget(target)).toBe(false)
    expect(shouldHandleDeleteShortcut(keyboardEvent('Delete', { target }))).toBe(true)
  })
})
