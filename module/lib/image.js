/**
 * KidsStar - Bild vor dem Hochladen verkleinern
 *
 * Fotos vom Telefon haben oft mehrere Megabyte. Im Browser auf hoechstens
 * 800 px verkleinert und als JPEG (bzw. WebP) neu kodiert, bleibt eine Kachel
 * bei wenigen hundert Kilobyte - und Metadaten wie der Aufnahmeort fallen weg.
 */

import { fitSize } from './kidsstar.js';

export async function shrinkImage(file, { max = 800, quality = 0.85 } = {}) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitSize(bitmap.width, bitmap.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('image_encode_failed');
  return blob;
}
