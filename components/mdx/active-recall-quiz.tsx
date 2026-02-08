"use client";

import { useMemo, useState } from "react";

type ActiveRecallItem = {
  question: string;
  markscheme: string;
};

type GradeResult = {
  score: number;
  verdict: "correct" | "partially-correct" | "incorrect";
  feedback: string;
  missingPoints: string[];
  improvements: string[];
};

type ActiveRecallQuizProps = {
  title?: string;
  items: ActiveRecallItem[];
};

function verdictStyles(verdict: GradeResult["verdict"]) {
  if (verdict === "correct") {
    return "bg-green-500/10 text-green-700 dark:text-green-300";
  }

  if (verdict === "partially-correct") {
    return "bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }

  return "bg-red-500/10 text-red-700 dark:text-red-300";
}

export function ActiveRecallQuiz({
  title = "Active Recall",
  items,
}: ActiveRecallQuizProps) {
  const [answers, setAnswers] = useState<string[]>(() => items.map(() => ""));
  const [results, setResults] = useState<Array<GradeResult | null>>(() =>
    items.map(() => null),
  );
  const [errors, setErrors] = useState<string[]>(() => items.map(() => ""));
  const [loadingIndex, setLoadingIndex] = useState<number | null>(null);

  const disabled = useMemo(() => loadingIndex !== null, [loadingIndex]);

  const updateAnswer = (index: number, value: string) => {
    setAnswers((previous) => {
      const next = previous.slice();
      next[index] = value;
      return next;
    });
  };

  const gradeAnswer = async (index: number) => {
    const answer = answers[index]?.trim();
    if (!answer) {
      setErrors((previous) => {
        const next = previous.slice();
        next[index] = "Write your answer before grading.";
        return next;
      });
      return;
    }

    setLoadingIndex(index);
    setErrors((previous) => {
      const next = previous.slice();
      next[index] = "";
      return next;
    });

    try {
      const response = await fetch("/api/active-recall/grade", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: items[index]?.question ?? "",
          markscheme: items[index]?.markscheme ?? "",
          answer,
        }),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          typeof body?.error === "string"
            ? body.error
            : "Unable to grade this answer right now.",
        );
      }

      setResults((previous) => {
        const next = previous.slice();
        next[index] = body as GradeResult;
        return next;
      });
    } catch (error) {
      setErrors((previous) => {
        const next = previous.slice();
        next[index] =
          error instanceof Error
            ? error.message
            : "Unable to grade this answer right now.";
        return next;
      });
    } finally {
      setLoadingIndex(null);
    }
  };

  return (
    <section className="my-6 rounded-xl border border-fd-border bg-fd-card p-4">
      <h3 className="text-lg font-semibold">{title}</h3>

      <div className="mt-4 space-y-4">
        {items.map((item, index) => {
          const result = results[index];
          const isLoading = loadingIndex === index;

          return (
            <article
              key={`${index}-${item.question}`}
              className="rounded-lg border border-fd-border/80 p-4"
            >
              <p className="font-medium">
                {index + 1}. {item.question}
              </p>

              <label
                className="mt-3 block text-sm font-medium"
                htmlFor={`active-recall-answer-${index}`}
              >
                Your answer
              </label>
              <textarea
                id={`active-recall-answer-${index}`}
                className="mt-1 min-h-20 w-full rounded-md border border-fd-border bg-fd-background px-3 py-2 text-sm outline-none transition focus:border-fd-primary"
                value={answers[index] ?? ""}
                onChange={(event) =>
                  updateAnswer(index, event.currentTarget.value)
                }
                placeholder="Type your answer..."
                disabled={disabled}
              />

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md bg-fd-primary px-3 py-1.5 text-sm font-medium text-fd-primary-foreground disabled:opacity-60"
                  onClick={() => gradeAnswer(index)}
                  disabled={disabled}
                >
                  {isLoading ? "Grading..." : "Grade"}
                </button>
              </div>

              {errors[index] ? (
                <p className="mt-2 text-sm text-red-600 dark:text-red-300">
                  {errors[index]}
                </p>
              ) : null}

              {result ? (
                <div className="mt-3 rounded-md border border-fd-border bg-fd-muted/30 p-3">
                  <p className="text-sm">
                    <span className="font-semibold">Score:</span> {result.score}
                    /100
                  </p>
                  <p className="mt-1 text-sm">
                    <span
                      className={`inline-block rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${verdictStyles(result.verdict)}`}
                    >
                      {result.verdict.replace("-", " ")}
                    </span>
                  </p>
                  <p className="mt-2 text-sm">{result.feedback}</p>

                  {result.missingPoints.length > 0 ? (
                    <div className="mt-2">
                      <p className="text-sm font-medium">Missing points</p>
                      <ul className="ml-5 list-disc text-sm">
                        {result.missingPoints.map((point) => (
                          <li key={point}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {result.improvements.length > 0 ? (
                    <div className="mt-2">
                      <p className="text-sm font-medium">How to improve</p>
                      <ul className="ml-5 list-disc text-sm">
                        {result.improvements.map((point) => (
                          <li key={point}>{point}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Show mark scheme
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-sm text-fd-muted-foreground">
                  {item.markscheme}
                </p>
              </details>
            </article>
          );
        })}
      </div>
    </section>
  );
}
