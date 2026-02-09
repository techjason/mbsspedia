"use client";

import Image from "next/image";
import Zoom from "react-medium-image-zoom";
import "../../styles/image-zoom.css";

type DiagramCardProps = {
  /** Image source path (relative to public/) */
  src: string;
  /** Alt text for accessibility */
  alt?: string;
  /** Caption shown below the thumbnail */
  caption?: string;
};

export function DiagramCard({ src, alt, caption }: DiagramCardProps) {
  return (
    <figure className="not-prose my-4 inline-block">
      <Zoom
        zoomMargin={20}
        wrapElement="span"
        zoomImg={{ src }}
      >
        <div className="group w-[140px] cursor-zoom-in overflow-hidden rounded-lg border border-fd-border bg-fd-card shadow-sm transition-shadow hover:shadow-md">
          <div className="flex items-center justify-center bg-fd-muted/40 p-2">
            <Image
              src={src}
              alt={alt ?? caption ?? "Diagram"}
              width={140}
              height={100}
              sizes="140px"
              className="h-[100px] w-auto object-contain"
            />
          </div>
          {caption && (
            <div className="border-t border-fd-border px-2 py-1.5">
              <figcaption className="text-xs font-medium leading-tight text-fd-muted-foreground">
                {caption}
              </figcaption>
            </div>
          )}
        </div>
      </Zoom>
    </figure>
  );
}

type DiagramGalleryProps = {
  children: React.ReactNode;
};

export function DiagramGallery({ children }: DiagramGalleryProps) {
  return (
    <div className="not-prose my-4 flex flex-wrap gap-3">
      {children}
    </div>
  );
}
