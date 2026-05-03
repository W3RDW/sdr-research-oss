import { useMemo } from "react";

interface TranscriptSyncProps {
  transcript: string;
  currentTime: number;
  duration: number;
}

interface WordSegment {
  word: string;
  start: number;
  end: number;
}

function TranscriptSync({ transcript, currentTime, duration }: TranscriptSyncProps) {
  // Estimate word timings based on character position
  const segments = useMemo((): WordSegment[] => {
    if (!transcript || duration === 0) return [];

    const words = transcript.split(/\s+/).filter((w) => w.length > 0);
    const totalChars = transcript.length;
    if (totalChars === 0) return [];

    const result: WordSegment[] = [];
    let charPos = 0;

    for (const word of words) {
      const startTime = (charPos / totalChars) * duration;
      charPos += word.length + 1; // +1 for space
      const endTime = (charPos / totalChars) * duration;
      result.push({ word, start: startTime, end: endTime });
    }

    return result;
  }, [transcript, duration]);

  if (!transcript) {
    return <div className="text-gray-500 italic">No transcript available</div>;
  }

  return (
    <div className="leading-relaxed">
      {segments.map((segment, index) => {
        const isActive =
          currentTime >= segment.start && currentTime < segment.end;
        const isPast = currentTime >= segment.end;

        return (
          <span
            key={index}
            className={`inline transition-colors ${
              isActive
                ? "bg-green-600 text-white px-1 rounded"
                : isPast
                ? "text-gray-300"
                : "text-gray-500"
            }`}
          >
            {segment.word}{" "}
          </span>
        );
      })}
    </div>
  );
}

export default TranscriptSync;
