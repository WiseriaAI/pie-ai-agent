export async function* readSSELines(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent: string | undefined;
  let currentData: string[] = [];

  try {
    while (true) {
      if (signal?.aborted) break;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete last line in buffer

      for (let line of lines) {
        line = line.replace(/\r$/, ""); // handle \r\n line endings
        if (line === "") {
          // empty line = event boundary
          if (currentData.length > 0) {
            yield { event: currentEvent, data: currentData.join("\n") };
          }
          currentEvent = undefined;
          currentData = [];
        } else if (line.startsWith("event:")) {
          currentEvent = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          currentData.push(line.slice(5).trimStart());
        }
        // ignore comments (lines starting with ':') and other fields
      }
    }

    // flush remaining data
    if (currentData.length > 0) {
      yield { event: currentEvent, data: currentData.join("\n") };
    }
  } finally {
    reader.releaseLock();
  }
}
