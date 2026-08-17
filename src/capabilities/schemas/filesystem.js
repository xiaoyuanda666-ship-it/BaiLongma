// 文件系统工具 schema：read_file / list_dir / write_file / edit_file / delete_file / make_dir
export const filesystemSchemas = {
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. This is the correct way to read a file — do NOT shell out through exec_command (Get-Content / cat / type), which risks encoding garble. Accepts a relative path (inside the sandbox) or an absolute path such as D:\\notes\\a.txt when the file sandbox is disabled. Use start_line/end_line/max_lines when the user asks for a limited range such as "first 120 lines"; do not read the whole file when a range is enough.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Absolute or relative file path.'
          },
          start_line: {
            type: 'number',
            description: 'Optional 1-based first line to read.'
          },
          end_line: {
            type: 'number',
            description: 'Optional 1-based last line to read, inclusive.'
          },
          max_lines: {
            type: 'number',
            description: 'Optional maximum number of lines to return, starting from start_line or line 1.'
          },
          include_metadata: {
            type: 'boolean',
            description: 'Return a structured result with content, byte/line counts, and SHA-256 even when reading the whole file. Use this before a line-based edit when concurrent changes are possible.'
          }
        },
        required: ['path']
      }
    }
  },

  list_dir: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and folders under a directory. Prefer this over shelling out through exec_command (Get-ChildItem / ls / dir). Accepts a relative path (inside the sandbox) or an absolute path such as D:\\projects when the file sandbox is disabled.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Directory path, defaults to the current directory.'
          }
        },
        required: []
      }
    }
  },

  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a text file or deliberately replace its entire contents. For a change to one line or block of an existing file, use edit_file instead so unchanged content is not retransmitted or overwritten. Pass the full file body verbatim in content. Missing parent directories are created automatically; the write is atomic and is read back for verification. Existing files are rejected by default. Set if_exists="overwrite" only when the user intends to replace the whole file. If you previously read an existing file with include_metadata=true, pass expected_sha256 to reject a stale overwrite. For articles/reports/notes prefer Markdown. Never build file content through run_command or shell redirection because quoting and encoding are unsafe.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'File path.'
          },
          content: {
            type: 'string',
            description: 'Content to write.'
          },
          if_exists: {
            type: 'string',
            enum: ['overwrite', 'error'],
            description: 'What to do if the file already exists. Defaults to error. Pass overwrite explicitly only for a deliberate whole-file replacement.'
          },
          expected_sha256: {
            type: 'string',
            description: 'Optional SHA-256 returned by read_file(include_metadata=true). The write fails if the current file no longer has this digest.'
          }
        },
        required: ['path', 'content']
      }
    }
  },

  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Modify part of an existing UTF-8 text file atomically, without sending or overwriting the whole file. Read the relevant section first. Prefer operation="replace" with an exact, unique old_text plus enough unchanged surrounding context; it safely fails when the text is missing or ambiguous. Use replace_lines only when exact text replacement is impractical, and pass expected_sha256 from read_file(include_metadata=true) when stale line numbers are a risk. append and prepend add content verbatim. The tool preserves all untouched bytes, preserves the existing line-ending style for line-range edits, rejects protected files, and reads the result back to verify it.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Existing file path.'
          },
          operation: {
            type: 'string',
            enum: ['replace', 'replace_lines', 'append', 'prepend'],
            description: 'Edit strategy. replace is the safest default.'
          },
          old_text: {
            type: 'string',
            description: 'For replace: exact existing text to find. Include surrounding lines so it matches only once.'
          },
          new_text: {
            type: 'string',
            description: 'For replace: exact replacement text. May be empty to delete old_text.'
          },
          replace_all: {
            type: 'boolean',
            description: 'For replace only: replace every exact occurrence. Defaults to false; multiple matches otherwise fail safely.'
          },
          start_line: {
            type: 'integer',
            minimum: 1,
            description: 'For replace_lines: 1-based first line to replace.'
          },
          end_line: {
            type: 'integer',
            minimum: 1,
            description: 'For replace_lines: 1-based last line to replace, inclusive. Defaults to start_line.'
          },
          content: {
            type: 'string',
            description: 'For replace_lines, append, or prepend: content to add. For replace_lines it may be empty to delete the selected lines.'
          },
          expected_sha256: {
            type: 'string',
            description: 'Optional SHA-256 returned by read_file(include_metadata=true). The edit fails if the file changed after it was read.'
          }
        },
        required: ['path', 'operation']
      }
    }
  },

  delete_file: {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or directory. This is the correct way to delete — do NOT shell out through exec_command (Remove-Item / rm / del), which skips the read-back confirmation and the protection on system files. Directories are removed recursively. System files such as readme.txt and world.txt cannot be deleted. Accepts a relative path (inside the sandbox) or an absolute path when the file sandbox is disabled.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File or directory path to delete. Relative paths resolve inside the sandbox; an absolute path is allowed when the file sandbox is disabled.' }
        },
        required: ['path']
      }
    }
  },

  make_dir: {
    type: 'function',
    function: {
      name: 'make_dir',
      description: 'Create a directory. Prefer this over shelling out through exec_command (New-Item / mkdir). Nested paths such as projects/myapp/src are created in one call. Accepts a relative path (inside the sandbox) or an absolute path when the file sandbox is disabled. (write_file already creates parent directories on its own, so you rarely need this just to prepare a file path.)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path to create.' }
        },
        required: ['path']
      }
    }
  },
}
