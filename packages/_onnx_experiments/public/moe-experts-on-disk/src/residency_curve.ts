import type { ExpertStorage } from './model_types.js';

///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ResidencyCurve — the picture issue #168 asks for
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * Model size along the bottom, tokens each second up the side, and one line for each of the three places weights can
 * live.
 *
 * The important part of this picture is where a line **stops**. A storage class that cannot hold the model has no
 * point at that size, and the whole claim of https://github.com/webai-at-home/webai-at-home/issues/168 is that the
 * disk line keeps going after the other two have run out.
 *
 * Both axes are logarithmic, because the sizes on one and the rates on the other each cover more than a factor of
 * ten and a straight scale would put every point but one in a corner.
 */

/** One measured run, as this chart wants it. */
export type CurvePoint = {
	/** How many bytes every expert of the model comes to. */
	size: number;
	/** How many tokens each second that run managed. */
	rate: number;
	/** Which model it was. */
	label: string;
};

/** How each line is drawn and what it is called. */
const LINE_STYLES: Record<ExpertStorage, { colour: string; title: string }> = {
	'graphics-memory': {
		colour: '#6f6',
		title: 'in graphics memory',
	},
	'main-memory': {
		colour: '#6cf',
		title: 'in main memory',
	},
	disk: {
		colour: '#fd6',
		title: 'on disk',
	},
};

/** Where the plotting area sits inside the drawing. */
const AREA = {
	left: 90,
	right: 640,
	top: 40,
	bottom: 380,
};

/**
 * How large the whole drawing is.
 *
 * Set from here rather than from the `viewBox` written in the page, so that the two cannot disagree. They did: the
 * legend was written past the right edge of a narrower box and the notes beside it lost their last few words.
 */
const CANVAS = {
	width: 1060,
	height: 460,
};

/**
 * Where each line's value labels sit relative to its dots, one entry for each line in the order they are drawn.
 *
 * Two storage classes measuring nearly the same rate put their dots on top of each other, and two numbers written at
 * the same place are two numbers nobody can read. The first line writes below its dots and the rest write above, at
 * increasing heights.
 */
const LABEL_OFFSETS = [20, -14, -30];

/** Draws the three lines. */
export class ResidencyCurve {
	/**
	 * Draws every measured run.
	 *
	 * @param canvas The drawing to fill.
	 * @param measured The points, grouped by where the weights were kept.
	 * @returns Nothing.
	 */
	static draw(canvas: SVGSVGElement, measured: Map<ExpertStorage, CurvePoint[]>): void {
		canvas.setAttribute('viewBox', `0 0 ${CANVAS.width} ${CANVAS.height}`);
		const points = [...measured.values()].flat();
		if (points.length === 0) {
			canvas.innerHTML = '';
			return;
		}
		const largestMeasuredSize = Math.max(...points.map((point) => point.size));

		const sizes = points.map((point) => point.size);
		const rates = points.map((point) => point.rate);
		const scale = {
			smallestSize: Math.min(...sizes) / 2,
			largestSize: Math.max(...sizes) * 2,
			smallestRate: Math.min(...rates) / 2,
			largestRate: Math.max(...rates) * 2,
		};

		const parts: string[] = [
			`<rect x="0" y="0" width="${CANVAS.width}" height="${CANVAS.height}" fill="#000" stroke="#333" />`,
			ResidencyCurve._text(
				(AREA.left + AREA.right) / 2,
				24,
				'Tokens each second against the size of the expert weights',
				'#fff',
				'middle',
			),
		];

		for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
			const y = AREA.bottom - fraction * (AREA.bottom - AREA.top);
			const rate = scale.smallestRate * Math.pow(scale.largestRate / scale.smallestRate, fraction);
			parts.push(`<line x1="${AREA.left}" y1="${y}" x2="${AREA.right}" y2="${y}" stroke="#222" />`);
			parts.push(ResidencyCurve._text(AREA.left - 10, y + 4, rate.toFixed(rate < 1 ? 2 : 1), '#888', 'end'));

			const x = AREA.left + fraction * (AREA.right - AREA.left);
			const size = scale.smallestSize * Math.pow(scale.largestSize / scale.smallestSize, fraction);
			parts.push(`<line x1="${x}" y1="${AREA.top}" x2="${x}" y2="${AREA.bottom}" stroke="#222" />`);
			parts.push(ResidencyCurve._text(
				x, AREA.bottom + 20, `${(size / 1024 / 1024 / 1024).toFixed(1)} GB`, '#888', 'middle',
			));
		}

		parts.push(`<line x1="${AREA.left}" y1="${AREA.bottom}" x2="${AREA.right}" y2="${AREA.bottom}" ` +
			'stroke="#666" />');
		parts.push(`<line x1="${AREA.left}" y1="${AREA.top}" x2="${AREA.left}" y2="${AREA.bottom}" stroke="#666" />`);
		parts.push(ResidencyCurve._text(
			(AREA.left + AREA.right) / 2, AREA.bottom + 46, 'every expert of the model, in gigabytes', '#aaa', 'middle',
		));
		parts.push(`<text x="24" y="${(AREA.top + AREA.bottom) / 2}" fill="#aaa" font-size="13" ` +
			`font-family="ui-monospace, monospace" text-anchor="middle" ` +
			`transform="rotate(-90 24 ${(AREA.top + AREA.bottom) / 2})">tokens each second</text>`);

		let legendY = AREA.top + 10;
		let lineIndex = 0;
		for (const [storage, style] of Object.entries(LINE_STYLES) as [ExpertStorage, typeof LINE_STYLES.disk][]) {
			const labelOffset = LABEL_OFFSETS[lineIndex % LABEL_OFFSETS.length];
			lineIndex++;
			const line = (measured.get(storage) ?? []).slice().sort((left, right) => left.size - right.size);
			parts.push(`<line x1="${AREA.right + 30}" y1="${legendY - 4}" x2="${AREA.right + 60}" y2="${legendY - 4}" ` +
				`stroke="${style.colour}" stroke-width="2" />`);
			// A line that reaches a smaller size than another line says so here. That is the finding of the whole
			// picture, and a reader should not have to notice a missing dot to see it.
			const reached = line.length === 0 ? 0 : Math.max(...line.map((point) => point.size));
			let title = style.title;
			if (line.length === 0) {
				title = `${style.title} — no run fitted`;
			} else if (reached < largestMeasuredSize) {
				title = `${style.title} — stops at ${ResidencyCurve._gigabytes(reached)}`;
			}
			parts.push(ResidencyCurve._text(
				AREA.right + 68,
				legendY,
				title,
				line.length === 0 ? '#666' : '#ddd',
				'start',
			));
			legendY += 22;

			if (line.length === 0) {
				continue;
			}
			const placed = line.map((point) => {
				return {
					x: ResidencyCurve._place(point.size, scale.smallestSize, scale.largestSize, AREA.left, AREA.right),
					y: ResidencyCurve._place(point.rate, scale.smallestRate, scale.largestRate, AREA.bottom, AREA.top),
					point: point,
				};
			});
			if (placed.length > 1) {
				parts.push(`<polyline fill="none" stroke="${style.colour}" stroke-width="2" points="` +
					`${placed.map((entry) => `${entry.x.toFixed(1)},${entry.y.toFixed(1)}`).join(' ')}" />`);
			}
			for (const entry of placed) {
				parts.push(`<circle cx="${entry.x.toFixed(1)}" cy="${entry.y.toFixed(1)}" r="5" ` +
					`fill="${style.colour}" />`);
				parts.push(ResidencyCurve._text(
					entry.x, entry.y + labelOffset, entry.point.rate.toFixed(2), style.colour, 'middle',
				));
			}
		}

		let noteY = legendY + 16;
		for (const line of [
			'A line stops where that storage',
			'class can no longer hold the',
			'model on this machine. Where',
			'each one stops is the point of',
			'the picture, not its slope.',
		]) {
			parts.push(ResidencyCurve._text(AREA.right + 30, noteY, line, '#888', 'start'));
			noteY += 18;
		}

		canvas.innerHTML = parts.join('\n');
	}

	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////
	//	Helpers
	///////////////////////////////////////////////////////////////////////////////
	///////////////////////////////////////////////////////////////////////////////

	/**
	 * Formats a byte count in gigabytes.
	 *
	 * @param bytes The byte count.
	 * @returns The formatted text.
	 */
	static _gigabytes(bytes: number): string {
		return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
	}

	/**
	 * Places one value on a logarithmic axis.
	 *
	 * @param value The value.
	 * @param smallest What sits at the start of the axis.
	 * @param largest What sits at the end of it.
	 * @param start Where the axis starts, in drawing units.
	 * @param end Where it ends.
	 * @returns Where the value sits, in drawing units.
	 */
	static _place(value: number, smallest: number, largest: number, start: number, end: number): number {
		const fraction = Math.log(value / smallest) / Math.log(largest / smallest);
		return start + fraction * (end - start);
	}

	/**
	 * Writes one piece of text.
	 *
	 * @param x Where it sits across.
	 * @param y Where it sits down.
	 * @param content What it says.
	 * @param colour What colour it is.
	 * @param anchor Which end of it sits at the given place.
	 * @returns The markup.
	 */
	static _text(x: number, y: number, content: string, colour: string, anchor: string): string {
		return `<text x="${x}" y="${y}" fill="${colour}" font-size="13" font-family="ui-monospace, monospace" ` +
			`text-anchor="${anchor}">${content}</text>`;
	}
}
