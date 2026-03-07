"use client";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

type ActiveRecallItem = {
  question: string;
  markscheme: string;
};

type ActiveRecallQuizProps = {
  title?: string;
  items: ActiveRecallItem[];
};

export function ActiveRecallQuiz({
  title = "Active Recall",
  items,
}: ActiveRecallQuizProps) {
  return (
    <section className="my-6 rounded-xl border border-fd-border bg-fd-card p-4">
      <h3 className="text-lg font-semibold">{title}</h3>

      <Accordion type="single" collapsible className="mt-4">
        {items.map((item, index) => {
          return (
            <AccordionItem
              key={`${index}-${item.question}`}
              value={`active-recall-item-${index}`}
            >
              <AccordionTrigger className="text-sm font-medium">
                {index + 1}. {item.question}
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3">
                <p className="whitespace-pre-wrap text-sm text-fd-muted-foreground">
                  {item.markscheme}
                </p>
              </AccordionContent>
            </AccordionItem>
          );
        })}
      </Accordion>
    </section>
  );
}
