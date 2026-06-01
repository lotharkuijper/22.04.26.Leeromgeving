import { useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import { Bold, Italic, Heading2, List, ListOrdered, Link2, Unlink, X } from 'lucide-react';
import { useLanguage } from '../i18n';

interface RichTextEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

interface LinkDialogState {
  text: string;
  url: string;
  hasSelection: boolean;
  isEditing: boolean;
}

export function RichTextEditor({ value, onChange, placeholder, ariaLabel }: RichTextEditorProps) {
  const { t } = useLanguage();
  const lastEmitted = useRef<string>(value);
  const savedRange = useRef<{ from: number; to: number } | null>(null);
  const [linkDialog, setLinkDialog] = useState<LinkDialogState | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Markdown.configure({ html: false, transformPastedText: true }),
    ],
    content: value,
    editorProps: {
      attributes: {
        class:
          'prose prose-sm max-w-none focus:outline-none min-h-[18rem] px-3 py-2 ' +
          'prose-headings:mt-3 prose-headings:mb-2 prose-p:my-2 prose-a:text-sky-600',
        'data-testid': 'input-courseinfo-body',
        'aria-label': ariaLabel ?? '',
      },
    },
    onUpdate: ({ editor }) => {
      const md = editor.storage.markdown.getMarkdown();
      lastEmitted.current = md;
      onChange(md);
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (value === lastEmitted.current) return;
    const current = editor.storage.markdown.getMarkdown();
    if (value !== current) {
      editor.commands.setContent(value || '', { emitUpdate: false });
      lastEmitted.current = value;
    }
  }, [value, editor]);

  if (!editor) return null;

  function openLinkDialog() {
    if (!editor) return;
    const isEditing = editor.isActive('link');
    let { from, to } = editor.state.selection;
    // Bij een bestaande link zonder selectie: selecteer de hele link zodat we de
    // linktekst kunnen tonen en in-place kunnen bewerken.
    if (isEditing && from === to) {
      editor.chain().focus().extendMarkRange('link').run();
      const sel = editor.state.selection;
      from = sel.from;
      to = sel.to;
    }
    savedRange.current = { from, to };
    const hasSelection = from !== to;
    const selectedText = hasSelection ? editor.state.doc.textBetween(from, to, ' ') : '';
    const existingHref = (editor.getAttributes('link').href as string | undefined) ?? '';
    setLinkDialog({ text: selectedText, url: existingHref, hasSelection, isEditing });
  }

  function applyLink() {
    if (!editor || !linkDialog) return;
    const url = linkDialog.url.trim();
    if (!url) return;
    const text = linkDialog.text.trim();
    const range = savedRange.current;
    const chain = editor.chain().focus();
    if (range) chain.setTextSelection(range);

    const rangeText =
      range && range.from !== range.to
        ? editor.state.doc.textBetween(range.from, range.to, ' ')
        : '';
    const hadRange = !!range && range.from !== range.to;

    if (hadRange && (!text || text === rangeText)) {
      // Selectie/bestaande link behouden, alleen de href (her)plaatsen.
      chain.extendMarkRange('link').setLink({ href: url }).run();
    } else {
      // Lege cursor of gewijzigde tekst: vervang de range door nieuwe gelinkte tekst.
      chain
        .insertContent({
          type: 'text',
          text: text || url,
          marks: [{ type: 'link', attrs: { href: url } }],
        })
        .run();
    }
    savedRange.current = null;
    setLinkDialog(null);
  }

  function removeLink() {
    if (!editor) return;
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    savedRange.current = null;
    setLinkDialog(null);
  }

  return (
    <div>
      <EditorToolbar editor={editor} onLink={openLinkDialog} />
      <div className="rounded-b border border-t-0 border-slate-300 bg-white focus-within:ring-2 focus-within:ring-sky-500">
        <EditorContent editor={editor} />
      </div>
      {placeholder && editor.isEmpty && (
        <p className="mt-1 text-xs text-slate-400" data-testid="text-courseinfo-hint">
          {placeholder}
        </p>
      )}

      {linkDialog && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setLinkDialog(null);
          }}
          data-testid="dialog-link"
        >
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-semibold text-slate-900">
                {t('courseInfo.linkDialog.title')}
              </h3>
              <button
                type="button"
                onClick={() => setLinkDialog(null)}
                className="text-slate-400 hover:text-slate-600"
                aria-label={t('courseInfo.linkDialog.cancel')}
                data-testid="button-link-dialog-close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {t('courseInfo.linkDialog.textLabel')}
                </label>
                <input
                  type="text"
                  value={linkDialog.text}
                  onChange={(e) => setLinkDialog({ ...linkDialog, text: e.target.value })}
                  placeholder={t('courseInfo.linkDialog.textPlaceholder')}
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                  data-testid="input-link-text"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">
                  {t('courseInfo.linkDialog.urlLabel')}
                </label>
                <input
                  type="url"
                  value={linkDialog.url}
                  autoFocus
                  onChange={(e) => setLinkDialog({ ...linkDialog, url: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      applyLink();
                    }
                  }}
                  placeholder={t('courseInfo.linkDialog.urlPlaceholder')}
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500"
                  data-testid="input-link-url"
                />
              </div>
            </div>
            <div className="mt-5 flex items-center justify-between gap-2">
              <div>
                {linkDialog.isEditing && (
                  <button
                    type="button"
                    onClick={removeLink}
                    className="inline-flex items-center gap-1.5 rounded px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                    data-testid="button-link-remove"
                  >
                    <Unlink className="h-4 w-4" /> {t('courseInfo.linkDialog.remove')}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setLinkDialog(null)}
                  className="rounded border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  data-testid="button-link-cancel"
                >
                  {t('courseInfo.linkDialog.cancel')}
                </button>
                <button
                  type="button"
                  onClick={applyLink}
                  disabled={!linkDialog.url.trim()}
                  className="rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60"
                  data-testid="button-link-confirm"
                >
                  {t('courseInfo.linkDialog.confirm')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface EditorToolbarProps {
  editor: Editor;
  onLink: () => void;
}

function EditorToolbar({ editor, onLink }: EditorToolbarProps) {
  const { t } = useLanguage();
  const base =
    'inline-flex items-center justify-center h-8 w-8 rounded border border-slate-200 text-slate-700 hover:bg-slate-50';
  const activeCls = 'bg-sky-100 border-sky-300 text-sky-800';

  const btn = (active: boolean) => `${base} ${active ? activeCls : 'bg-white'}`;

  return (
    <div
      className="flex flex-wrap gap-1 rounded-t border border-slate-300 bg-slate-50 p-1.5"
      role="toolbar"
      aria-label={t('courseInfo.editorLabel')}
    >
      <button
        type="button"
        className={btn(editor.isActive('bold'))}
        title={`${t('courseInfo.toolbar.bold')} (Ctrl+B)`}
        aria-label={t('courseInfo.toolbar.bold')}
        aria-pressed={editor.isActive('bold')}
        onClick={() => editor.chain().focus().toggleBold().run()}
        data-testid="button-format-bold"
      >
        <Bold className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={btn(editor.isActive('italic'))}
        title={`${t('courseInfo.toolbar.italic')} (Ctrl+I)`}
        aria-label={t('courseInfo.toolbar.italic')}
        aria-pressed={editor.isActive('italic')}
        onClick={() => editor.chain().focus().toggleItalic().run()}
        data-testid="button-format-italic"
      >
        <Italic className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={btn(editor.isActive('heading', { level: 2 }))}
        title={t('courseInfo.toolbar.heading')}
        aria-label={t('courseInfo.toolbar.heading')}
        aria-pressed={editor.isActive('heading', { level: 2 })}
        onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        data-testid="button-format-heading"
      >
        <Heading2 className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={btn(editor.isActive('bulletList'))}
        title={t('courseInfo.toolbar.bullet')}
        aria-label={t('courseInfo.toolbar.bullet')}
        aria-pressed={editor.isActive('bulletList')}
        onClick={() => editor.chain().focus().toggleBulletList().run()}
        data-testid="button-format-bullet"
      >
        <List className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={btn(editor.isActive('orderedList'))}
        title={t('courseInfo.toolbar.numbered')}
        aria-label={t('courseInfo.toolbar.numbered')}
        aria-pressed={editor.isActive('orderedList')}
        onClick={() => editor.chain().focus().toggleOrderedList().run()}
        data-testid="button-format-numbered"
      >
        <ListOrdered className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={btn(editor.isActive('link'))}
        title={t('courseInfo.toolbar.link')}
        aria-label={t('courseInfo.toolbar.link')}
        aria-pressed={editor.isActive('link')}
        onClick={onLink}
        data-testid="button-format-link"
      >
        <Link2 className="h-4 w-4" />
      </button>
      {editor.isActive('link') && (
        <button
          type="button"
          className={btn(false)}
          title={t('courseInfo.toolbar.unlink')}
          aria-label={t('courseInfo.toolbar.unlink')}
          onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}
          data-testid="button-format-unlink"
        >
          <Unlink className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
