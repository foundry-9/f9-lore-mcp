type genericVectorizer = Partial<{
    idf: number[];
    tfidfMatrix: ItfidfMatrix;
}> & Partial<Record<string, unknown>>;

interface ItfidfMatrix {
    matrix: IMatrixEntry[];
    shape: number[];
    [ key: string ]: unknown;
}

interface IMatrixEntry {
    row: number;
    col: number;
    value: number;
}

export { genericVectorizer, ItfidfMatrix, IMatrixEntry };