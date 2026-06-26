import { useEditor, EditorContent } from '@tiptap/react'
import { StarterKit } from '@tiptap/starter-kit'
import Underline from '@tiptap/extension-underline'
import Highlight from '@tiptap/extension-highlight'
import Link from '@tiptap/extension-link'
import DOMPurify from 'dompurify'
import { useEffect } from 'react'

interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  minHeight?: number
  disabled?: boolean
}

function ToolbarButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void
  active?: boolean
  title: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={[
        'px-1.5 py-0.5 rounded text-xs font-mono transition-colors',
        active
          ? 'bg-sky/20 text-navy border border-sky/50'
          : 'text-navy/50 hover:text-navy hover:bg-navy/10 border border-transparent',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

export function RichTextEditor({ value, onChange, placeholder, minHeight = 160, disabled }: RichTextEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Highlight.configure({ multicolor: false }),
      Link.configure({ openOnClick: false, HTMLAttributes: { class: 'text-sky underline cursor-pointer' } }),
    ],
    content: value || '',
    editable: !disabled,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML()
      onChange(html === '<p></p>' ? '' : html)
    },
    editorProps: {
      attributes: {
        class: 'outline-none font-mono text-sm text-navy leading-relaxed',
        'data-placeholder': placeholder ?? 'Start typing…',
      },
    },
  })

  // Sync external value changes (e.g. when switching between records)
  useEffect(() => {
    if (!editor) return
    const current = editor.getHTML()
    const next = value || ''
    if (current !== next && !editor.isFocused) {
      editor.commands.setContent(next, false as any)
    }
  }, [editor, value])

  function addLink() {
    if (!editor) return
    const prev = editor.getAttributes('link').href as string | undefined
    const url = prompt('Enter URL', prev ?? 'https://')?.trim()
    if (!url) return
    if (url === '') {
      editor.chain().focus().unsetLink().run()
    } else {
      editor.chain().focus().setLink({ href: url }).run()
    }
  }

  if (!editor) return null

  return (
    <div className={['rounded border border-navy/30 bg-cream overflow-hidden', disabled ? 'opacity-60' : ''].join(' ')}>
      {/* Toolbar */}
      {!disabled && (
        <div className="flex items-center flex-wrap gap-0.5 px-2 py-1.5 border-b border-navy/20 bg-navy/5">
          <ToolbarButton onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold">B</ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic"><em>I</em></ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title="Underline"><span className="underline">U</span></ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough"><span className="line-through">S</span></ToolbarButton>
          <div className="w-px h-4 bg-navy/20 mx-0.5" />
          <ToolbarButton onClick={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')} title="Highlight">🖍</ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive('code')} title="Inline code"><code>`</code></ToolbarButton>
          <div className="w-px h-4 bg-navy/20 mx-0.5" />
          <ToolbarButton onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet list">• List</ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Numbered list">1. List</ToolbarButton>
          <div className="w-px h-4 bg-navy/20 mx-0.5" />
          <ToolbarButton onClick={addLink} active={editor.isActive('link')} title="Add link">🔗</ToolbarButton>
          <ToolbarButton onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()} title="Clear formatting">✕ fmt</ToolbarButton>
        </div>
      )}

      {/* Editor area — full area is clickable to place cursor */}
      <div
        className="relative px-3 py-2 cursor-text [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_a]:text-sky [&_a]:underline [&_a]:cursor-pointer"
        style={{ minHeight }}
        onClick={(e) => { if (e.target === e.currentTarget) editor.chain().focus('end').run() }}
      >
        {/* Placeholder — hide when list/block formatting is active (isEmpty is true for empty list items too) */}
        {editor.isEmpty && !editor.isActive('bulletList') && !editor.isActive('orderedList') && placeholder && (
          <div className="absolute top-2 left-3 text-sm font-mono text-inky/40 pointer-events-none select-none">
            {placeholder}
          </div>
        )}
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}

// Read-only render of stored HTML — always sanitize before use
export function RichTextDisplay({ html, className }: { html: string | null; className?: string }) {
  if (!html) return null
  const clean = DOMPurify.sanitize(html)
  return (
    <div
      className={['prose prose-sm max-w-none text-navy font-mono', className ?? ''].join(' ')}
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  )
}
