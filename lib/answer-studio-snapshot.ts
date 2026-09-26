import type {StudioDraft} from './answer-studio';
/** Deep-copy mutable records without repeatedly serializing immutable image
 * strings. Browser structuredClone otherwise copies all original pixels on
 * every checkpoint, even when IndexedDB already stores those pixels once. */
export function studioSnapshot<T extends StudioDraft>(draft:T):T {
  const copy=structuredClone({...draft,
    pages:draft.pages.map(page=>({...page,image:''})),
    questions:draft.questions.map(q=>({...q,diagrams:q.diagrams.map(d=>({...d,baseImage:''}))})),
  });
  copy.pages.forEach((page,i)=>{page.image=draft.pages[i].image;});
  copy.questions.forEach((q,i)=>q.diagrams.forEach((d,j)=>{d.baseImage=draft.questions[i].diagrams[j].baseImage;}));
  return copy;
}
