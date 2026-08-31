//! CDR (ROS 2) / ROS 1 binary deserialization directly into Arrow column builders.

use crate::rosmsg::{ArrayKind, FieldType, MsgDef, Prim};
use anyhow::{bail, Result};
use arrow::array::*;
use arrow::buffer::{Buffer, OffsetBuffer, ScalarBuffer};
use arrow::datatypes::Field;
use std::sync::Arc;

pub struct Reader<'a> {
    d: &'a [u8],
    pos: usize,
    le: bool,
    aligned: bool, // CDR aligns primitives; ROS1 serialization is packed
}

macro_rules! read_prim {
    ($fn:ident, $ty:ty, $n:expr) => {
        #[inline]
        pub fn $fn(&mut self) -> Result<$ty> {
            self.align($n);
            let b = self.take($n)?;
            let arr: [u8; $n] = b.try_into().unwrap();
            Ok(if self.le {
                <$ty>::from_le_bytes(arr)
            } else {
                <$ty>::from_be_bytes(arr)
            })
        }
    };
}

impl<'a> Reader<'a> {
    pub fn cdr(payload: &'a [u8]) -> Result<Self> {
        if payload.len() < 4 {
            bail!("payload too short for CDR encapsulation");
        }
        let le = match payload[1] {
            0 => false,
            1 => true,
            other => bail!("unsupported CDR encapsulation kind {other}"),
        };
        Ok(Reader {
            d: &payload[4..],
            pos: 0,
            le,
            aligned: true,
        })
    }

    pub fn ros1(payload: &'a [u8]) -> Self {
        Reader {
            d: payload,
            pos: 0,
            le: true,
            aligned: false,
        }
    }

    #[inline]
    fn align(&mut self, n: usize) {
        if self.aligned {
            let m = self.pos % n;
            if m != 0 {
                self.pos += n - m;
            }
        }
    }

    #[inline]
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.pos + n > self.d.len() {
            bail!(
                "buffer overrun: need {n} bytes at {} of {}",
                self.pos,
                self.d.len()
            );
        }
        let s = &self.d[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    #[inline]
    pub fn remaining(&self) -> usize {
        self.d.len().saturating_sub(self.pos)
    }

    #[inline]
    pub fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    #[inline]
    pub fn i8(&mut self) -> Result<i8> {
        Ok(self.take(1)?[0] as i8)
    }

    read_prim!(u16, u16, 2);
    read_prim!(i16, i16, 2);
    read_prim!(u32, u32, 4);
    read_prim!(i32, i32, 4);
    read_prim!(u64, u64, 8);
    read_prim!(i64, i64, 8);
    read_prim!(f32, f32, 4);
    read_prim!(f64, f64, 8);

    /// String payload bytes (without terminator).
    pub fn str_bytes(&mut self) -> Result<&'a [u8]> {
        let n = self.u32()? as usize;
        if self.aligned {
            // CDR: the length includes a NUL terminator, so a conforming string
            // is never zero-length. Verifying the terminator matters because the
            // alternative is to drop the last character of a malformed string
            // and hand the caller quietly corrupted text.
            if n == 0 {
                bail!("CDR string has length 0 (a terminator is always counted)");
            }
            let b = self.take(n)?;
            if b[n - 1] != 0 {
                bail!("CDR string of {n} bytes is not NUL-terminated");
            }
            Ok(&b[..n - 1])
        } else {
            self.take(n)
        }
    }

    pub fn wstr(&mut self) -> Result<String> {
        let n = self.u32()? as usize;
        if n.saturating_mul(2) > self.remaining() {
            bail!("wstring length {n} exceeds remaining buffer");
        }
        let mut v = Vec::with_capacity(n);
        for _ in 0..n {
            v.push(self.u16()?);
        }
        if v.last() == Some(&0) {
            v.pop();
        }
        Ok(String::from_utf16_lossy(&v))
    }
}

pub enum ColB {
    Bool(Vec<bool>),
    I8(Vec<i8>),
    U8(Vec<u8>),
    I16(Vec<i16>),
    U16(Vec<u16>),
    I32(Vec<i32>),
    U32(Vec<u32>),
    I64(Vec<i64>),
    U64(Vec<u64>),
    F32(Vec<f32>),
    F64(Vec<f64>),
    Str {
        offsets: Vec<i32>,
        data: Vec<u8>,
    },
    Bin {
        offsets: Vec<i64>,
        data: Vec<u8>,
    },
    FixedBin {
        n: usize,
        data: Vec<u8>,
    },
    List {
        offsets: Vec<i32>,
        child: Box<ColB>,
        /// smallest byte count one element can occupy, precomputed so a
        /// declared sequence length can be checked without walking the
        /// type tree on every message
        min_elem: usize,
    },
    FixedList {
        n: usize,
        child: Box<ColB>,
    },
    Struct {
        len: usize,
        children: Vec<ColB>,
    },
}

/// Arrow's `StringArray`/`ListArray` address their children with i32 offsets,
/// so a batch that accumulates more than 2 GiB of one column cannot be
/// represented. Fail loudly instead of wrapping the offset into nonsense.
fn offset_i32(len: usize, what: &str) -> Result<i32> {
    i32::try_from(len).map_err(|_| {
        anyhow::anyhow!(
            "{what} column reached {len} bytes in one batch, past Arrow's i32 offset limit — \
             lower max_batch_rows / max_batch_bytes"
        )
    })
}

pub fn new_builder(ft: &FieldType, defs: &[MsgDef]) -> ColB {
    match ft {
        FieldType::Prim(p) => match p {
            Prim::Bool => ColB::Bool(Vec::new()),
            Prim::I8 => ColB::I8(Vec::new()),
            Prim::U8 => ColB::U8(Vec::new()),
            Prim::I16 => ColB::I16(Vec::new()),
            Prim::U16 => ColB::U16(Vec::new()),
            Prim::I32 => ColB::I32(Vec::new()),
            Prim::U32 => ColB::U32(Vec::new()),
            Prim::I64 => ColB::I64(Vec::new()),
            Prim::U64 => ColB::U64(Vec::new()),
            Prim::F32 => ColB::F32(Vec::new()),
            Prim::F64 => ColB::F64(Vec::new()),
            Prim::Str | Prim::WStr => ColB::Str {
                offsets: vec![0],
                data: Vec::new(),
            },
        },
        FieldType::Complex(i) => ColB::Struct {
            len: 0,
            children: defs[*i]
                .fields
                .iter()
                .map(|(_, ft)| new_builder(ft, defs))
                .collect(),
        },
        FieldType::Array(inner, kind) => {
            if matches!(inner.as_ref(), FieldType::Prim(Prim::U8)) {
                return match kind {
                    ArrayKind::Fixed(n) => ColB::FixedBin {
                        n: *n,
                        data: Vec::new(),
                    },
                    ArrayKind::Unbounded => ColB::Bin {
                        offsets: vec![0],
                        data: Vec::new(),
                    },
                };
            }
            let child = Box::new(new_builder(inner, defs));
            match kind {
                ArrayKind::Fixed(n) => ColB::FixedList { n: *n, child },
                ArrayKind::Unbounded => ColB::List {
                    offsets: vec![0],
                    child,
                    min_elem: crate::rosmsg::min_serialized_size(inner, defs),
                },
            }
        }
    }
}

pub fn col_len(b: &ColB) -> usize {
    match b {
        ColB::Bool(v) => v.len(),
        ColB::I8(v) => v.len(),
        ColB::U8(v) => v.len(),
        ColB::I16(v) => v.len(),
        ColB::U16(v) => v.len(),
        ColB::I32(v) => v.len(),
        ColB::U32(v) => v.len(),
        ColB::I64(v) => v.len(),
        ColB::U64(v) => v.len(),
        ColB::F32(v) => v.len(),
        ColB::F64(v) => v.len(),
        ColB::Str { offsets, .. } => offsets.len() - 1,
        ColB::Bin { offsets, .. } => offsets.len() - 1,
        ColB::FixedBin { n, data } => {
            if *n == 0 {
                0
            } else {
                data.len() / n
            }
        }
        ColB::List { offsets, .. } => offsets.len() - 1,
        ColB::FixedList { n, child } => {
            if *n == 0 {
                0
            } else {
                col_len(child) / n
            }
        }
        ColB::Struct { len, .. } => *len,
    }
}

pub fn append(ft: &FieldType, b: &mut ColB, r: &mut Reader, defs: &[MsgDef]) -> Result<()> {
    match (ft, b) {
        (FieldType::Prim(Prim::Bool), ColB::Bool(v)) => v.push(r.u8()? != 0),
        (FieldType::Prim(Prim::I8), ColB::I8(v)) => v.push(r.i8()?),
        (FieldType::Prim(Prim::U8), ColB::U8(v)) => v.push(r.u8()?),
        (FieldType::Prim(Prim::I16), ColB::I16(v)) => v.push(r.i16()?),
        (FieldType::Prim(Prim::U16), ColB::U16(v)) => v.push(r.u16()?),
        (FieldType::Prim(Prim::I32), ColB::I32(v)) => v.push(r.i32()?),
        (FieldType::Prim(Prim::U32), ColB::U32(v)) => v.push(r.u32()?),
        (FieldType::Prim(Prim::I64), ColB::I64(v)) => v.push(r.i64()?),
        (FieldType::Prim(Prim::U64), ColB::U64(v)) => v.push(r.u64()?),
        (FieldType::Prim(Prim::F32), ColB::F32(v)) => v.push(r.f32()?),
        (FieldType::Prim(Prim::F64), ColB::F64(v)) => v.push(r.f64()?),
        (FieldType::Prim(Prim::Str), ColB::Str { offsets, data }) => {
            let s = r.str_bytes()?;
            data.extend_from_slice(s);
            offsets.push(offset_i32(data.len(), "string")?);
        }
        (FieldType::Prim(Prim::WStr), ColB::Str { offsets, data }) => {
            let s = r.wstr()?;
            data.extend_from_slice(s.as_bytes());
            offsets.push(offset_i32(data.len(), "string")?);
        }
        (FieldType::Complex(i), ColB::Struct { len, children }) => {
            for ((_, fty), cb) in defs[*i].fields.iter().zip(children.iter_mut()) {
                append(fty, cb, r, defs)?;
            }
            *len += 1;
        }
        (FieldType::Array(_, _), ColB::Bin { offsets, data }) => {
            let n = r.u32()? as usize;
            let bytes = r.take(n)?;
            data.extend_from_slice(bytes);
            offsets.push(data.len() as i64);
        }
        (FieldType::Array(_, _), ColB::FixedBin { n, data }) => {
            let bytes = r.take(*n)?;
            data.extend_from_slice(bytes);
        }
        (
            FieldType::Array(inner, _),
            ColB::List {
                offsets,
                child,
                min_elem,
            },
        ) => {
            let n = r.u32()? as usize;
            // Bound the count by what the remaining bytes could actually hold.
            // Comparing against the byte count alone would wrongly reject a
            // valid sequence of field-less messages, which encode to nothing.
            if *min_elem > 0 {
                if n.saturating_mul(*min_elem) > r.remaining() {
                    bail!("sequence of {n} elements exceeds the remaining buffer");
                }
            } else if n > crate::rosmsg::MAX_ARRAY_ELEMENTS {
                bail!(
                    "sequence of {n} zero-sized elements exceeds the {} element limit",
                    crate::rosmsg::MAX_ARRAY_ELEMENTS
                );
            }
            for _ in 0..n {
                append(inner, child, r, defs)?;
            }
            offsets.push(offset_i32(col_len(child), "list")?);
        }
        (FieldType::Array(inner, _), ColB::FixedList { n, child }) => {
            for _ in 0..*n {
                append(inner, child, r, defs)?;
            }
        }
        _ => bail!("internal error: builder/type mismatch"),
    }
    Ok(())
}

/// Consume the builder and produce an Arrow array; `ft` must be the type the
/// builder was created from.
pub fn finish(b: ColB, ft: &FieldType, defs: &[MsgDef]) -> ArrayRef {
    match b {
        ColB::Bool(v) => Arc::new(BooleanArray::from(v)),
        ColB::I8(v) => Arc::new(Int8Array::from(v)),
        ColB::U8(v) => Arc::new(UInt8Array::from(v)),
        ColB::I16(v) => Arc::new(Int16Array::from(v)),
        ColB::U16(v) => Arc::new(UInt16Array::from(v)),
        ColB::I32(v) => Arc::new(Int32Array::from(v)),
        ColB::U32(v) => Arc::new(UInt32Array::from(v)),
        ColB::I64(v) => Arc::new(Int64Array::from(v)),
        ColB::U64(v) => Arc::new(UInt64Array::from(v)),
        ColB::F32(v) => Arc::new(Float32Array::from(v)),
        ColB::F64(v) => Arc::new(Float64Array::from(v)),
        ColB::Str { offsets, data } => Arc::new(StringArray::new(
            OffsetBuffer::new(ScalarBuffer::from(offsets)),
            Buffer::from_vec(data),
            None,
        )),
        ColB::Bin { offsets, data } => Arc::new(LargeBinaryArray::new(
            OffsetBuffer::new(ScalarBuffer::from(offsets)),
            Buffer::from_vec(data),
            None,
        )),
        ColB::FixedBin { n, data } => Arc::new(
            FixedSizeBinaryArray::try_new(n as i32, Buffer::from_vec(data), None)
                .expect("fixed-size binary build"),
        ),
        ColB::List { offsets, child, .. } => {
            let inner_ft = match ft {
                FieldType::Array(inner, _) => inner.as_ref(),
                _ => unreachable!("list builder with non-array type"),
            };
            let child_arr = finish(*child, inner_ft, defs);
            let field = Arc::new(Field::new("item", child_arr.data_type().clone(), false));
            Arc::new(ListArray::new(
                field,
                OffsetBuffer::new(ScalarBuffer::from(offsets)),
                child_arr,
                None,
            ))
        }
        ColB::FixedList { n, child } => {
            let inner_ft = match ft {
                FieldType::Array(inner, _) => inner.as_ref(),
                _ => unreachable!("list builder with non-array type"),
            };
            let child_arr = finish(*child, inner_ft, defs);
            let field = Arc::new(Field::new("item", child_arr.data_type().clone(), false));
            Arc::new(FixedSizeListArray::new(field, n as i32, child_arr, None))
        }
        ColB::Struct { len, children } => {
            let def_idx = match ft {
                FieldType::Complex(i) => *i,
                _ => unreachable!("struct builder with non-complex type"),
            };
            if children.is_empty() {
                return Arc::new(StructArray::new_empty_fields(len, None));
            }
            let fields = crate::rosmsg::struct_fields(def_idx, defs);
            let arrays: Vec<ArrayRef> = children
                .into_iter()
                .zip(defs[def_idx].fields.iter())
                .map(|(cb, (_, fty))| finish(cb, fty, defs))
                .collect();
            Arc::new(StructArray::new(fields, arrays, None))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rosmsg::{self, ArrayKind};

    /// wrap a CDR body in a little-endian encapsulation header
    fn cdr(body: &[u8]) -> Vec<u8> {
        let mut v = vec![0x00, 0x01, 0x00, 0x00];
        v.extend_from_slice(body);
        v
    }

    fn le_u32(n: u32) -> Vec<u8> {
        n.to_le_bytes().to_vec()
    }

    #[test]
    fn cdr_string_round_trips() {
        let mut body = le_u32(3); // length counts the NUL
        body.extend_from_slice(b"hi\0");
        let buf = cdr(&body);
        let mut r = Reader::cdr(&buf).unwrap();
        assert_eq!(r.str_bytes().unwrap(), b"hi");
    }

    #[test]
    fn unterminated_cdr_string_is_an_error_not_a_truncation() {
        let mut body = le_u32(3);
        body.extend_from_slice(b"hey"); // no NUL: silently dropping 'y' would corrupt
        let buf = cdr(&body);
        let mut r = Reader::cdr(&buf).unwrap();
        assert!(r.str_bytes().is_err());
    }

    #[test]
    fn zero_length_cdr_string_is_an_error() {
        let buf = cdr(&le_u32(0));
        let mut r = Reader::cdr(&buf).unwrap();
        assert!(r.str_bytes().is_err());
    }

    #[test]
    fn oversized_sequence_is_rejected() {
        let reg = rosmsg::parse("pkg/Top", "float64[] values\n", false).unwrap();
        let ft = &reg.defs[reg.top].fields[0].1;
        let mut b = new_builder(ft, &reg.defs);
        // claims a million doubles but carries none
        let buf = cdr(&le_u32(1_000_000));
        let mut r = Reader::cdr(&buf).unwrap();
        assert!(append(ft, &mut b, &mut r, &reg.defs).is_err());
    }

    #[test]
    fn sequence_of_field_less_messages_is_accepted() {
        // Elements encode to zero bytes, so bounding the count by the bytes
        // left would wrongly reject a perfectly valid message.
        let schema = "pkg/Empty[] items\n===\nMSG: pkg/Empty\n";
        let reg = rosmsg::parse("pkg/Top", schema, false).unwrap();
        let ft = &reg.defs[reg.top].fields[0].1;
        assert_eq!(rosmsg::min_serialized_size(ft, &reg.defs), 4);
        let mut b = new_builder(ft, &reg.defs);
        let buf = cdr(&le_u32(3));
        let mut r = Reader::cdr(&buf).unwrap();
        append(ft, &mut b, &mut r, &reg.defs).expect("valid empty-element sequence");
        assert_eq!(col_len(&b), 1);
    }

    #[test]
    fn absurd_zero_sized_sequence_is_still_bounded() {
        let schema = "pkg/Empty[] items\n===\nMSG: pkg/Empty\n";
        let reg = rosmsg::parse("pkg/Top", schema, false).unwrap();
        let ft = &reg.defs[reg.top].fields[0].1;
        let mut b = new_builder(ft, &reg.defs);
        let buf = cdr(&le_u32(u32::MAX));
        let mut r = Reader::cdr(&buf).unwrap();
        assert!(append(ft, &mut b, &mut r, &reg.defs).is_err());
    }

    #[test]
    fn fixed_array_dimension_is_capped() {
        assert!(rosmsg::parse(
            "pkg/Top",
            "pkg/Empty[4294967295] items\n===\nMSG: pkg/Empty\n",
            false
        )
        .is_err());
        // a realistic fixed array still resolves
        let reg = rosmsg::parse("pkg/Top", "float64[36] covariance\n", false).unwrap();
        match &reg.defs[reg.top].fields[0].1 {
            FieldType::Array(_, ArrayKind::Fixed(n)) => assert_eq!(*n, 36),
            other => panic!("unexpected type {other:?}"),
        }
    }

    #[test]
    fn min_serialized_size_walks_nested_types() {
        let schema = "pkg/Inner[2] pairs\nuint8 flag\n===\nMSG: pkg/Inner\nint32 a\nfloat64 b\n";
        let reg = rosmsg::parse("pkg/Top", schema, false).unwrap();
        let fields = &reg.defs[reg.top].fields;
        // two Inners of (4 + 8) bytes each
        assert_eq!(rosmsg::min_serialized_size(&fields[0].1, &reg.defs), 24);
        assert_eq!(rosmsg::min_serialized_size(&fields[1].1, &reg.defs), 1);
    }
}
