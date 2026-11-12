import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, Volume2, VolumeX, Music, Disc } from 'lucide-react';

interface AudioTrack {
  id: string;
  title: string;
  subtitle: string;
  duration: number; // in seconds
}

const SAMPLE_TRACKS: AudioTrack[] = [
  {
    id: 'track-1',
    title: 'لحن شيري ني ماريا (السلام لكِ يا مريم)',
    subtitle: 'ألحان فصل مارجرجس بالزيتون',
    duration: 184
  },
  {
    id: 'track-2',
    title: 'مديح الشهيد العظيم مارجرجس الروماني',
    subtitle: 'تمجيد شفيع الخدمة - كنيسة العذراء',
    duration: 215
  },
  {
    id: 'track-3',
    title: 'لحن أجيوس القبطي السنوي',
    subtitle: 'تسجيلات طقس القداس الإلهي',
    duration: 152
  }
];

export interface GlassAudioPlayerProps {
  title?: string;
  duration?: number;
  className?: string;
}

export const GlassAudioPlayer: React.FC<GlassAudioPlayerProps> = ({
  className = ''
}) => {
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);

  const track = SAMPLE_TRACKS[currentTrackIndex];
  const audioContextRef = useRef<AudioContext | null>(null);
  const oscillatorRef = useRef<OscillatorNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const intervalRef = useRef<any>(null);

  // Synthesize soft ambient meditative tone when playing (reliable, zero external url failure)
  const startAudioTone = () => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      if (!audioContextRef.current) {
        audioContextRef.current = new AudioCtx();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') {
        ctx.resume();
      }

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      // Harmonic meditative frequency in C (261.63 Hz)
      osc.frequency.setValueAtTime(currentTrackIndex === 0 ? 261.63 : currentTrackIndex === 1 ? 293.66 : 329.63, ctx.currentTime);

      gain.gain.setValueAtTime(isMuted ? 0 : volume * 0.08, ctx.currentTime);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();

      oscillatorRef.current = osc;
      gainNodeRef.current = gain;
    } catch {}
  };

  const stopAudioTone = () => {
    try {
      if (oscillatorRef.current) {
        oscillatorRef.current.stop();
        oscillatorRef.current.disconnect();
        oscillatorRef.current = null;
      }
    } catch {}
  };

  const togglePlay = () => {
    if (isPlaying) {
      stopAudioTone();
      setIsPlaying(false);
      clearInterval(intervalRef.current);
    } else {
      startAudioTone();
      setIsPlaying(true);
      intervalRef.current = setInterval(() => {
        setCurrentTime((prev) => {
          if (prev >= track.duration) {
            return 0;
          }
          return prev + 1;
        });
      }, 1000);
    }
  };

  // Adjust volume
  useEffect(() => {
    if (gainNodeRef.current && audioContextRef.current) {
      gainNodeRef.current.gain.setValueAtTime(isMuted ? 0 : volume * 0.08, audioContextRef.current.currentTime);
    }
  }, [volume, isMuted]);

  useEffect(() => {
    return () => {
      stopAudioTone();
      clearInterval(intervalRef.current);
    };
  }, []);

  const formatTime = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const progressPercent = (currentTime / track.duration) * 100;

  return (
    <div className={`glass-strong p-4 sm:p-5 relative overflow-hidden select-none ${className}`}>
      {/* Subtle Cyan Backlight Accent */}
      <div className="absolute top-0 right-0 w-32 h-32 bg-[var(--accent)]/10 rounded-full blur-2xl pointer-events-none" />

      <div className="flex flex-col sm:flex-row items-center gap-4 relative z-10">
        {/* Cover / Icon Box */}
        <div className="relative w-16 h-16 sm:w-20 sm:h-20 rounded-2xl bg-gradient-to-br from-[var(--navy-mid)] to-[var(--navy)] border border-[var(--glass-border-2)] shadow-[0_0_16px_rgba(32,199,232,0.25)] flex items-center justify-center shrink-0">
          <Disc className={`w-8 h-8 text-[var(--accent)] ${isPlaying ? 'animate-spin' : ''}`} style={{ animationDuration: '6s' }} />
          {isPlaying && (
            <span className="absolute inset-0 rounded-2xl ring-2 ring-[var(--accent)] animate-ping opacity-25" />
          )}
        </div>

        {/* Track Info & Controls */}
        <div className="flex-1 w-full space-y-2 text-right">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-[var(--accent)]/15 border border-[var(--accent)]/30 text-[var(--accent)]">
                مشغل التسابيح والألحان
              </span>
              <h4 className="font-extrabold text-sm sm:text-base text-[var(--text)] mt-1 m-0 line-clamp-1">
                {track.title}
              </h4>
              <p className="text-xs text-[var(--text-secondary)] m-0">
                {track.subtitle}
              </p>
            </div>

            {/* 7 Animated Equalizer Bars */}
            <div className="flex items-end gap-1 h-5 pt-1">
              {[1, 2, 3, 4, 5, 6, 7].map((bar) => (
                <div
                  key={bar}
                  className="audio-bar"
                  style={{
                    animationPlayState: isPlaying ? 'running' : 'paused',
                    opacity: isPlaying ? 1 : 0.35
                  }}
                />
              ))}
            </div>
          </div>

          {/* Progress Slider */}
          <div className="space-y-1">
            <div
              className="w-full h-2 rounded-full bg-[var(--navy)]/80 border border-[var(--glass-border)] cursor-pointer overflow-hidden relative"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                // RTL adjustment
                const ratio = 1 - clickX / rect.width;
                setCurrentTime(Math.floor(ratio * track.duration));
              }}
            >
              <div
                className="h-full bg-gradient-to-l from-[var(--accent)] to-[var(--primary)] transition-all duration-200 shadow-[0_0_8px_rgba(32,199,232,0.5)]"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] font-mono font-bold text-[var(--text-muted)]">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(track.duration)}</span>
            </div>
          </div>

          {/* Controls Bar */}
          <div className="flex items-center justify-between pt-1">
            {/* Play / Pause Lens Button */}
            <button
              type="button"
              onClick={togglePlay}
              className="btn--lens px-4 py-1.5 flex items-center gap-1.5 cursor-pointer shadow-md text-xs font-bold active:scale-95"
            >
              {isPlaying ? (
                <>
                  <Pause className="w-4 h-4 text-white" />
                  <span>إيقاف مؤقت</span>
                </>
              ) : (
                <>
                  <Play className="w-4 h-4 text-white" />
                  <span>تشغيل اللحن</span>
                </>
              )}
            </button>

            {/* Track Selector & Volume */}
            <div className="flex items-center gap-3">
              <select
                value={currentTrackIndex}
                onChange={(e) => {
                  stopAudioTone();
                  setIsPlaying(false);
                  setCurrentTime(0);
                  setCurrentTrackIndex(Number(e.target.value));
                }}
                className="text-[11px] font-bold rounded-lg bg-[var(--navy)]/90 border border-[var(--glass-border)] text-[var(--text)] px-2 py-1 cursor-pointer focus:outline-none focus:border-[var(--accent)]"
              >
                {SAMPLE_TRACKS.map((t, idx) => (
                  <option key={t.id} value={idx}>
                    لحن {idx + 1}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => setIsMuted(!isMuted)}
                className="p-1.5 rounded-lg bg-[var(--glass-bg)] border border-[var(--glass-border)] text-[var(--text-secondary)] hover:text-[var(--text)] cursor-pointer"
                title={isMuted ? 'إلغاء الكتم' : 'كتم الصوت'}
              >
                {isMuted ? <VolumeX className="w-3.5 h-3.5 text-red-400" /> : <Volume2 className="w-3.5 h-3.5 text-[var(--accent)]" />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
