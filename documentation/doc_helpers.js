const fs = require('fs');
const path = require('path');
const docx = require('docx');

const {
  Document,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  HeadingLevel,
  BorderStyle,
  ImageRun,
  Header,
  Footer,
  PageNumber,
  NumberFormat,
  TableOfContents,
  Packer,
} = docx;

// Color Palette Constants
const COLOR_PRIMARY = '0F172A'; // Dark Navy
const COLOR_NAVY = '1E3A8A';    // Classic Royal Navy
const COLOR_BLUE = '2563EB';    // Accent Blue
const COLOR_MUTED = '475569';   // Slate Grey
const COLOR_TEXT = '1E293B';    // Charcoal Body Text
const COLOR_BG_LIGHT = 'F8FAFC';// Off-white zebra
const COLOR_BORDER = 'CBD5E1';  // Table/Box Border
const COLOR_CALLOUT_BG = 'EFF6FF'; // Callout Box Fill
const COLOR_WARN_BG = 'FFFBEB';    // Warning Fill
const COLOR_WARN_BORDER = 'D97706';// Warning Border
const COLOR_CODE_BG = 'F1F5F9';    // Code Block Fill

// Helper for paragraphs
function p(text, options = {}) {
  const runs = Array.isArray(text)
    ? text
    : [
        new TextRun({
          text: text || '',
          font: options.font || 'Arial',
          size: options.size || 21, // 10.5 pt
          color: options.color || COLOR_TEXT,
          bold: options.bold || false,
          italics: options.italics || false,
        }),
      ];

  return new Paragraph({
    alignment: options.alignment || AlignmentType.LEFT,
    spacing: {
      before: options.spaceBefore !== undefined ? options.spaceBefore : 120, // 6pt
      after: options.spaceAfter !== undefined ? options.spaceAfter : 120,   // 6pt
      line: options.line || 276, // 1.15 line spacing
    },
    bullet: options.bullet ? { level: options.bulletLevel || 0 } : undefined,
    children: runs,
  });
}

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 180 },
    children: [
      new TextRun({
        text,
        font: 'Arial',
        size: 32, // 16 pt
        bold: true,
        color: COLOR_NAVY,
      }),
    ],
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 140 },
    children: [
      new TextRun({
        text,
        font: 'Arial',
        size: 26, // 13 pt
        bold: true,
        color: COLOR_BLUE,
      }),
    ],
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100 },
    children: [
      new TextRun({
        text,
        font: 'Arial',
        size: 22, // 11 pt
        bold: true,
        color: COLOR_PRIMARY,
      }),
    ],
  });
}

function bullet(text, boldPrefix = '') {
  const children = [];
  if (boldPrefix) {
    children.push(
      new TextRun({
        text: boldPrefix + ' ',
        font: 'Arial',
        size: 21,
        bold: true,
        color: COLOR_TEXT,
      })
    );
  }
  children.push(
    new TextRun({
      text,
      font: 'Arial',
      size: 21,
      color: COLOR_TEXT,
    })
  );
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { before: 60, after: 60, line: 260 },
    children,
  });
}

function callout(title, text, type = 'info') {
  const isWarn = type === 'warn';
  const borderColor = isWarn ? COLOR_WARN_BORDER : COLOR_BLUE;
  const bgColor = isWarn ? COLOR_WARN_BG : COLOR_CALLOUT_BG;

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE },
      bottom: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE },
      left: { style: BorderStyle.SINGLE, size: 24, color: borderColor },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: bgColor },
            margins: { top: 140, bottom: 140, left: 180, right: 180 },
            children: [
              new Paragraph({
                spacing: { before: 0, after: 60 },
                children: [
                  new TextRun({
                    text: title,
                    font: 'Arial',
                    size: 21,
                    bold: true,
                    color: isWarn ? 'B45309' : COLOR_NAVY,
                  }),
                ],
              }),
              new Paragraph({
                spacing: { before: 0, after: 0, line: 260 },
                children: [
                  new TextRun({
                    text,
                    font: 'Arial',
                    size: 20,
                    color: COLOR_TEXT,
                  }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
}

function codeBlock(codeLines) {
  const lines = Array.isArray(codeLines) ? codeLines : codeLines.split('\n');
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: COLOR_CODE_BG },
            margins: { top: 120, bottom: 120, left: 160, right: 160 },
            children: lines.map(
              (line) =>
                new Paragraph({
                  spacing: { before: 20, after: 20, line: 240 },
                  children: [
                    new TextRun({
                      text: line || ' ',
                      font: 'Consolas',
                      size: 19, // 9.5 pt
                      color: '1E293B',
                    }),
                  ],
                })
            ),
          }),
        ],
      }),
    ],
  });
}

function createTable(headers, rows, colWidths = []) {
  const tableRows = [];

  // Header row
  tableRows.push(
    new TableRow({
      tableHeader: true,
      children: headers.map((h, i) => {
        const cellOpts = {
          shading: { fill: COLOR_NAVY },
          margins: { top: 120, bottom: 120, left: 140, right: 140 },
          children: [
            new Paragraph({
              alignment: AlignmentType.LEFT,
              spacing: { before: 0, after: 0 },
              children: [
                new TextRun({
                  text: h,
                  font: 'Arial',
                  size: 19,
                  bold: true,
                  color: 'FFFFFF',
                }),
              ],
            }),
          ],
        };
        if (colWidths[i]) {
          cellOpts.width = { size: colWidths[i], type: WidthType.PERCENTAGE };
        }
        return new TableCell(cellOpts);
      }),
    })
  );

  // Data rows
  rows.forEach((row, rIdx) => {
    const isEven = rIdx % 2 === 1;
    tableRows.push(
      new TableRow({
        children: row.map((cellText, i) => {
          const cellOpts = {
            shading: isEven ? { fill: COLOR_BG_LIGHT } : undefined,
            margins: { top: 100, bottom: 100, left: 140, right: 140 },
            children: [
              new Paragraph({
                alignment: AlignmentType.LEFT,
                spacing: { before: 0, after: 0, line: 240 },
                children: [
                  new TextRun({
                    text: cellText || '',
                    font: 'Arial',
                    size: 19,
                    color: COLOR_TEXT,
                  }),
                ],
              }),
            ],
          };
          if (colWidths[i]) {
            cellOpts.width = { size: colWidths[i], type: WidthType.PERCENTAGE };
          }
          return new TableCell(cellOpts);
        }),
      })
    );
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      left: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      right: { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: 'E2E8F0' },
      insideVertical: { style: BorderStyle.SINGLE, size: 2, color: 'E2E8F0' },
    },
    rows: tableRows,
  });
}

module.exports = {
  p,
  h1,
  h2,
  h3,
  bullet,
  callout,
  codeBlock,
  createTable,
  COLOR_PRIMARY,
  COLOR_NAVY,
  COLOR_BLUE,
  COLOR_MUTED,
  COLOR_TEXT,
  COLOR_BORDER,
};
