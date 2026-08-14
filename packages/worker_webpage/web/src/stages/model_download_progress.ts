///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////
//	ModelDownloadProgress — one step of progress while a complete language model downloads
///////////////////////////////////////////////////////////////////////////////
///////////////////////////////////////////////////////////////////////////////

/**
 * One step of progress reported while a complete language model downloads and loads.
 *
 * A `message` step is a human-readable line describing an overall stage, such as a readiness
 * check or the model becoming ready to run. A `file_progress` step reports how much of one file
 * has arrived so far. A `file_done` step reports that one file has finished downloading, so the
 * reader knows to stop showing progress for that file.
 */
export type ModelDownloadProgress =
	| {
		/** A human-readable line describing an overall stage of downloading or loading. */
		kind: 'message';
		/** The human-readable line to show. */
		message: string;
	}
	| {
		/** How much of one file has arrived so far. */
		kind: 'file_progress';
		/** The file's full path within the model repository, such as `onnx/model_q4f16.onnx_data`. */
		file: string;
		/** How much of that file has arrived, from 0 to 100. */
		percent: number;
	}
	| {
		/** One file has finished downloading. */
		kind: 'file_done';
		/** The file's full path within the model repository, matching an earlier `file_progress` step. */
		file: string;
	};
