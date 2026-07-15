// 媒体类工具 schema：speak / generate_lyrics / media_mode / generate_music / generate_image / music
export const mediaSchemas = {
  speak: {
    type: 'function',
    function: {
      name: 'speak',
      description: 'Convert text to speech and save it as an audio file. Use only for creative content such as poems, prose, narration, or lyric reading. Do not use for normal chat replies; voice replies are handled automatically by the system. Keep text under 500 Chinese characters.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to convert to speech.' },
          voice_id: { type: 'string', description: 'Optional voice ID. Omit this unless the user explicitly asks for a specific known voice. The system uses the configured TTS voice by default; a voice ID must belong to the current TTS provider.' },
          filename: { type: 'string', description: 'Optional output filename without extension.' },
        },
        required: ['text']
      }
    }
  },

  generate_lyrics: {
    type: 'function',
    function: {
      name: 'generate_lyrics',
      description: 'Generate complete song lyrics from a creative direction, including title, style tags, and lyric structure. The result is saved automatically under sandbox/lyrics/ and can be passed to generate_music.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Creative direction, theme, or emotional description for the lyrics.' },
          mode: { type: 'string', description: 'Mode: write_full_song by default, generating complete lyrics.' },
        },
        required: ['prompt']
      }
    }
  },

  media_mode: {
    type: 'function',
    function: {
      name: 'media_mode',
      description: `Control the brain-ui media stage. video opens from the right, image opens from the left, and music opens a record-player card from the right.
Platform selection (check Country Code / Timezone from Supplemental Context):
  - China (CN / Asia/Shanghai etc.) → prefer Bilibili for videos.
  - Other regions → prefer YouTube for videos.
Video URL rules, important because violations can cause a blank player:
  - YouTube: use a full watch URL such as https://www.youtube.com/watch?v=xxx or a youtu.be short link. A bare videoId string is invalid. The video must be public and embeddable, not private, region-locked, or login-gated.
  - Bilibili: the URL must include a BV id, such as https://www.bilibili.com/video/BVxxxxx.
  - Direct video links: must be directly accessible .mp4/.webm or similar URLs; confirm the link works and allows cross-origin access.
  - Never pass guessed URLs, inaccessible private videos, or platform share pages that are not embeddable playback links.
  - Recommended: use search first to find and confirm the video, then call media_mode. Prefer official channels and high-view public videos.
Pressing V only pauses and collapses the panel while preserving content; close/hide actions actually destroy the video.
Music mode rules:
  - src should be a local absolute file path with file:// prefix, or a direct HTTP audio URL. Confirm the file exists before playing.
  - lrc is optional LRC-format lyric text, such as [mm:ss.xx]lyric line.
  - When playing music, no chat reply is needed; call the tool directly.
  - Press M to collapse or expand the panel.`,
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['video', 'camera', 'image', 'music'], description: 'video=right-side video mode; camera=right-side camera video; image=left-side image mode; music=right-side record-player mode.' },
          action: { type: 'string', enum: ['show', 'hide', 'close', 'play', 'pause', 'seek', 'set_volume', 'update'], description: 'show loads media; hide/close closes and destroys it; play/pause controls playback; seek jumps; set_volume adjusts volume.' },
          url: { type: 'string', description: 'Media URL for video/image. Must be a complete accessible URL following the tool rules.' },
          src: { type: 'string', description: 'Audio file path for music mode. Use file:///absolute/path for local files or an HTTP direct audio link.' },
          title: { type: 'string', description: 'Optional media title.' },
          artist: { type: 'string', description: 'Optional artist name for music mode.' },
          lrc: { type: 'string', description: 'Optional LRC-format lyrics for music mode, e.g. [mm:ss.xx]lyric line.' },
          cover: { type: 'string', description: 'Optional cover image path or URL for music mode.' },
          alt: { type: 'string', description: 'Optional image alt description.' },
          autoplay: { type: 'boolean', description: 'Autoplay, default true.' },
          muted: { type: 'boolean', description: 'Mute direct-link video, default false.' },
          volume: { type: 'number', description: 'Volume 0-1.' },
          currentTime: { type: 'number', description: 'Seconds to seek to.' },
          camera: { type: 'boolean', description: 'Explicitly open camera when mode=video; default false.' },
        },
        required: ['mode']
      }
    }
  },

  generate_music: {
    type: 'function',
    function: {
      name: 'generate_music',
      description: 'Generate music from a description and optional lyrics, then save it as an audio file. You can generate lyrics first with generate_lyrics, then pass them here to create a full song.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Music style and emotional description, such as melancholic piano or upbeat pop.' },
          lyrics: { type: 'string', description: 'Optional lyrics. Omit to generate instrumental music, usually with instrumental=true.' },
          instrumental: { type: 'boolean', description: 'Generate instrumental music without vocals, default false.' },
        },
        required: ['prompt']
      }
    }
  },

  generate_image: {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate images from a text description. Daily image generation limit is 50.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Image description. More detail is better.' },
          aspect_ratio: { type: 'string', description: 'Aspect ratio, optional values: 1:1 default, 16:9, 4:3, 3:4, 9:16.' },
          n: { type: 'number', description: 'Number of images to generate, 1-4, default 1.' },
        },
        required: ['prompt']
      }
    }
  },

  music: {
    type: 'function',
    function: {
      name: 'music',
      description: `Manage and play the local music library. Music files are stored under the music directory.
Supported actions:
  - list: list all tracks in the library, including id, title, artist, and file_path.
  - search: search by song title or artist.
  - download: download a song as mp3 and add it to the library. PREFERRED: pass query="song artist" (or title/artist) and let the tool handle it: it scans/reuses existing local files, resolves YouTube/Bilibili direct video links, tries platform search fallbacks, and prepares/refreshes yt-dlp when needed. Do NOT use web_search, web_read, or exec_command to manually hunt links after this tool fails; call music(download) with a better query/title/artist instead, or ask the user for a local file/direct audio URL. Optionally set platform="youtube"|"bilibili" (use bilibili for CN users). Pass url= only when you already have a confirmed video page URL. Lyrics are fetched automatically when possible.
  - add: add an existing local audio file, such as mp3/flac/wav/aac, to the library.
  - scan: scan the music directory and add all audio files in batch.
  - get_lyrics: fetch LRC lyrics from lrclib.net and save them to the library. Requires title + artist.
  - delete: remove a track from the library by id without deleting the actual file.
To play music, use media_mode with mode=music and src=file_path to show the record player. No chat reply is needed before playback; execute directly.`,
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'search', 'download', 'add', 'scan', 'get_lyrics', 'delete'], description: 'Action type.' },
          query:  { type: 'string', description: 'For search: local library query (title/artist). For download: keywords like "song artist" so the tool auto-searches and downloads the first match (no URL needed).' },
          platform: { type: 'string', enum: ['youtube', 'bilibili'], description: 'For download with query: which site to search first. Use bilibili for CN users, youtube otherwise. The tool auto-falls-back to the other if the first fails. Ignored when url is given.' },
          url:    { type: 'string', description: 'Optional explicit YouTube/BiliBili video page URL for download. Only pass when you already have a confirmed URL; otherwise prefer query.' },
          path:   { type: 'string', description: 'Absolute local audio file path for add.' },
          title:  { type: 'string', description: 'Track title, useful for add/download/get_lyrics.' },
          artist: { type: 'string', description: 'Artist name, useful for add/download/get_lyrics.' },
          album:  { type: 'string', description: 'Optional album name.' },
          id:     { type: 'number', description: 'Track id for get_lyrics/delete.' },
          limit:  { type: 'number', description: 'Maximum rows returned by list/search, default 50.' },
        },
        required: ['action']
      }
    }
  },
}
