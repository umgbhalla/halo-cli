import React from "react";
import { CopyIcon } from "lucide-react";
import { useCopyToClipboard } from "usehooks-ts";

import { Col } from "~/lib/ui/components/custom/Col";
import { Row } from "~/lib/ui/components/custom/Row";
import { Button } from "~/lib/ui/components/ui/Button";
import { Tooltip } from "~/lib/ui/components/ui/Tooltip";
import { toast } from "~/lib/ui/hooks/useToast.hook";
import { cn } from "~/lib/ui/utils/utils";

type CommandBlockProps = React.HTMLAttributes<HTMLDivElement> & {
  cmd: string;
  toastDescription?: string;
  wrap?: boolean;
};

export function CommandBlock({
  className,
  cmd,
  toastDescription,
  wrap = true,
  ...rest
}: CommandBlockProps) {
  const [_, copy] = useCopyToClipboard();

  const handleCopy = () => {
    void copy(cmd);
    toast.success({
      description:
        toastDescription ?? "The command has been copied to your clipboard.",
      title: "Code Copied",
    });
  };

  return (
    <Row
      className={cn(
        "w-full min-w-0 justify-between gap-3 rounded-xl border border-subtle bg-muted p-3 text-sm",
        className,
      )}
      {...rest}
    >
      <Row className="min-w-0 flex-1 items-center justify-between">
        <pre
          className={cn(
            "min-w-0 font-mono",
            wrap
              ? "whitespace-pre-wrap break-words"
              : "overflow-x-auto whitespace-pre",
          )}
        >
          <code className="text-detail-success">{cmd}</code>
        </pre>
      </Row>
      <Col className="h-full items-start">
        <Tooltip content="Copy to clipboard">
          <Button
            aria-label="Copy to clipboard"
            className="shrink-0"
            onClick={handleCopy}
            size="icon"
            variant="secondary"
          >
            <CopyIcon className="size-4" />
          </Button>
        </Tooltip>
      </Col>
    </Row>
  );
}
