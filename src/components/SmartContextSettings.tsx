
import React from 'react';
import type { SillyTavernPreset } from '../types';
import { SliderInput } from './ui/SliderInput';
import { SelectInput } from './ui/SelectInput';
import { LabeledTextarea } from './ui/LabeledTextarea';

interface SmartContextSettingsProps {
    preset: SillyTavernPreset;
    onUpdate: (updatedPreset: SillyTavernPreset) => void;
}

export const SmartContextSettings: React.FC<SmartContextSettingsProps> = ({ preset, onUpdate }) => {
    
    const handleUpdate = (key: keyof SillyTavernPreset, value: any) => {
        onUpdate({ ...preset, [key]: value });
    };

    return (
        <div className="space-y-8">
            <h3 className="text-xl font-bold text-sky-400 mb-4">Smart Context & Memory</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-6">
                    <SliderInput
                        label="Ngưỡng Kích Hoạt Tóm Tắt (Context Depth)"
                        value={preset.context_depth || 20}
                        onChange={(v) => handleUpdate('context_depth', v)}
                        min={4}
                        max={100}
                        step={2}
                    />

                    <SliderInput
                        label="Kích Thước Gói Tóm Tắt (Chunk Size)"
                        value={preset.summarization_chunk_size || 10}
                        onChange={(v) => handleUpdate('summarization_chunk_size', v)}
                        min={1}
                        max={preset.context_depth || 20}
                        step={1}
                    />

                    <SelectInput 
                        label="Chế độ Ghép nối Lịch sử"
                        value={preset.context_mode || 'standard'}
                        onChange={(e) => handleUpdate('context_mode', e.target.value)}
                        options={[
                            { value: 'standard', label: 'Tiêu chuẩn (Cả User & AI)' },
                            { value: 'ai_only', label: 'Chế độ Tự thuật (Chỉ AI)' }
                        ]}
                    />
                </div>

                <div className="space-y-4">
                    <LabeledTextarea 
                        label="Lời nhắc Tóm tắt (Summarization Prompt)"
                        value={preset.summarization_prompt || ''}
                        onChange={(e) => handleUpdate('summarization_prompt', e.target.value)}
                        rows={10}
                    />
                </div>
            </div>
        </div>
    );
};
