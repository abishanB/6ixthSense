import type { BuildingModelType } from "../map/snapToRoad";

export const BUILDING_TEMPLATE_MIME = "application/x-building-template";

export interface BuildingTemplate {
  id: string;
  label: string;
  widthM: number;
  depthM: number;
  defaultHeightM: number;
  modelType?: BuildingModelType;
}

interface BuildingPaletteProps {
  templates: ReadonlyArray<BuildingTemplate>;
  selectedTemplateId: string;
  onSelectTemplate: (templateId: string) => void;
  onTemplateDragStart?: (template: BuildingTemplate) => void;
  onTemplateDragEnd?: () => void;
}

let transparentDragImage: HTMLCanvasElement | null = null;

function getTransparentDragImage(): HTMLCanvasElement {
  if (!transparentDragImage) {
    transparentDragImage = document.createElement("canvas");
    transparentDragImage.width = 1;
    transparentDragImage.height = 1;
  }
  return transparentDragImage;
}

export function BuildingPalette({
  templates,
  selectedTemplateId,
  onSelectTemplate,
  onTemplateDragStart,
  onTemplateDragEnd,
}: BuildingPaletteProps) {
  return (
    <div className="building-palette">
      <h2>Building Palette</h2>
      <p className="palette-help">Drag a template onto the map to place it.</p>
      <div className="palette-list">
        {templates.map((template) => (
          <button
            key={template.id}
            type="button"
            className={`palette-card ${selectedTemplateId === template.id ? "is-selected" : ""}`}
            draggable
            onClick={() => onSelectTemplate(template.id)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setDragImage(getTransparentDragImage(), 0, 0);
              event.dataTransfer.setData(BUILDING_TEMPLATE_MIME, JSON.stringify(template));
              onTemplateDragStart?.(template);
            }}
            onDragEnd={() => {
              onTemplateDragEnd?.();
            }}
          >
            <span className="palette-title">{template.label}</span>
            <span className="palette-meta">
              {template.widthM}m x {template.depthM}m
            </span>
            <span className="palette-meta">Height {template.defaultHeightM}m</span>
          </button>
        ))}
      </div>
    </div>
  );
}
