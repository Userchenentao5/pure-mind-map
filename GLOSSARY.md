# Simple Obsidian Mind Map

An Obsidian plugin that renders standard Markdown notes as interactive mind maps with seamless switching to native Markdown source editing.

## Language

**Mind Map Note**:
A standard Markdown (`.md`) file in the Obsidian vault whose YAML frontmatter marks it as a mind map, causing it to open in the mind map canvas by default.
_Avoid_: Mind map file, diagram file, canvas note

**Node**:
A single topic entry in the mind map tree, mapped to a Markdown heading or list item and rendered with inline Obsidian Markdown syntax.
_Avoid_: Item, box, card, topic element

**Node Inline Editor**:
The active text-editing session on a Node, encompassing text formatting, clipboard editing, pill overlay alignment, explicit commit, and inline link/embed completion.
_Avoid_: Input box, topic input, inline popup

**Link Suggestion**:
The floating completion list triggered by `[[` or `![[` inside a Node Inline Editor to search and insert vault notes or media embeds.
_Avoid_: Autocomplete dropdown, file picker

**Source Mode**:
Editing a Mind Map Note inside Obsidian's native Markdown editor instead of the mind map canvas.
_Avoid_: Raw mode, text view, code mode

**View-Mode Override**:
A temporary per-tab exemption that keeps a Mind Map Note in Source Mode until the tab navigates to a different note or switches back to the mind map canvas.
_Avoid_: Force markdown flag, bypass list
